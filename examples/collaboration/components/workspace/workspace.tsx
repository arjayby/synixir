"use client";
import { inspectForTest } from "@/lib/browser-test";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { SynixirRoom, type RoomState } from "@synixir/client";
import {
  Check,
  CircleHelp,
  ExternalLink,
  Plus,
  ShieldCheck,
  Undo2,
  Redo2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { PlaygroundHeader } from "@/components/playground-header";
import { RoomDialog } from "@/components/room-dialog";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { api, explain, type User, type Member, type Session } from "@/lib/api";
import { example, type ExampleKind } from "@/lib/examples";

type Surface = (() => void) & { setReadOnly(value: boolean): void };
const initial: RoomState = {
  connection: "disconnected",
  role: null,
  readOnly: true,
  saveStatus: "not-saved",
  hasUnsavedChanges: false,
  error: null,
  saveError: null,
};
const saveLabels = {
  "not-saved": "Not saved",
  saving: "Saving",
  saved: "Saved",
  unsaved: "Unsaved changes",
  failed: "Save failed",
  "view-only": "View only",
};
const labels: Partial<Record<RoomState["connection"], string>> = {
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};
const errors: Record<string, string> = {
  node_channel_quota:
    "The server has reached its connection limit. Keep your draft and try again later.",
  room_channel_quota:
    "This room has reached its participant limit. Keep your draft and try again later.",
  account_channel_quota:
    "Too many room tabs are open for this account. Disconnect another tab before retrying.",
  document_quota:
    "The server has reached its active document limit. Keep your draft and try again later.",
  storage_quota:
    "This room has reached its storage limit. Keep this tab open or copy your draft, and ask an operator for more space before retrying.",
  message_too_large:
    "This update exceeds the transfer limit. Keep this tab open and reduce the size of your changes before retrying.",
  rate_limited:
    "Too many updates at once. Wait a moment, then disconnect and connect to retry. Keep this tab open.",
  invalid_message:
    "The server rejected this update. Keep this tab open so your draft remains available.",
  timeout:
    "The save acknowledgement did not arrive. Disconnect and connect again to confirm your edits. Keep this tab open.",
};
async function loadSurface(
  kind: ExampleKind,
): Promise<(room: SynixirRoom) => Surface> {
  switch (kind) {
    case "kanban":
      return (await import("@/kanban/board")).createBoard;
    case "whiteboard":
      return (await import("@/whiteboard/canvas")).createWhiteboard;
    case "flowchart":
      return (await import("@/flowchart/canvas")).createFlowchart;
    case "table":
      return (await import("@/table/table")).createCollaborativeTable;
    case "multiplayer-form":
      return (await import("@/multiplayer-form/form")).createMultiplayerForm;
    case "rich-text":
      return (await import("@/rich-text/editor")).createRichText;
    default: {
      const { createEditor } = await import("@/editor");
      return (room) =>
        createEditor(room.doc.getText("content"), room.awareness);
    }
  }
}

const SurfaceHost = memo(function SurfaceHost({
  title,
  hint,
}: {
  title: string;
  hint: string;
}) {
  return (
    <section className="document-panel" aria-label={title}>
      <div className="editor-toolbar">
        <span id="document-title" className="document-title">
          {title}
        </span>
        <div role="group" aria-label="Edit history" className="flex gap-1">
          <Button id="undo" type="button" variant="ghost" size="sm" disabled>
            <Undo2 data-icon="inline-start" />
            Undo
          </Button>
          <Button id="redo" type="button" variant="ghost" size="sm" disabled>
            <Redo2 data-icon="inline-start" />
            Redo
          </Button>
        </div>
      </div>
      <div id="editor" className="surface" />
      <p id="board-announcement" className="sr-only" role="status" />
      <div className="editor-footer">
        <span id="editor-help">{hint}. Undo affects your own changes.</span>
        <span id="word-count" className="text-xs" />
      </div>
    </section>
  );
});
interface Peer {
  id: number;
  name: string;
  local: boolean;
}
interface Props {
  kind: ExampleKind;
  roomId: string;
  user: User;
  cleanupRef: RefObject<() => void>;
  unsavedRef: RefObject<() => boolean>;
  accountMenu: ReactNode;
  accountError: ReactNode;
}
export function Workspace({
  kind,
  roomId,
  user,
  cleanupRef,
  unsavedRef,
  accountMenu,
  accountError,
}: Props) {
  const selected = example(kind);
  const [state, setState] = useState<RoomState>(initial);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [memberError, setMemberError] = useState("");
  const [memberPending, setMemberPending] = useState(false);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [startupError, setStartupError] = useState("");
  const roomRef = useRef<SynixirRoom | null>(null);
  const surfaceRef = useRef<Surface | null>(null);
  const frozen =
    state.error?.code === "access_changed" ||
    state.error?.code === "account_changed";
  const active = ["connected", "connecting", "reconnecting"].includes(
    state.connection,
  );

  useEffect(() => {
    let disposed = false;
    let stopState = () => {};
    let stopPresence = () => {};
    let current: SynixirRoom | null = null;
    const unload = (event: BeforeUnloadEvent) => {
      if (current?.state.hasUnsavedChanges) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    function dispose() {
      if (disposed) return;
      disposed = true;
      stopState();
      stopPresence();
      surfaceRef.current?.();
      surfaceRef.current = null;
      void current?.destroy();
      current = null;
      roomRef.current = null;
    }
    cleanupRef.current = dispose;
    unsavedRef.current = () => Boolean(current?.state.hasUnsavedChanges);
    window.addEventListener("beforeunload", unload);
    window.addEventListener("pagehide", dispose);
    void (async () => {
      const create = await loadSurface(kind);
      if (disposed) return;
      current = new SynixirRoom({ roomId, userId: user.id });
      const room = current;
      roomRef.current = room;
      inspectForTest({ room });
      room.awareness.setLocalStateField("user", {
        name: user.username,
        color: "#3565b0",
        colorLight: "#3565b026",
      });
      surfaceRef.current = create(room);
      let previousRoster = "";
      const presence = () => {
        const online = room.state.connection === "connected";
        const list: Peer[] = [...room.awareness.getStates()]
          .filter(
            ([id, value]) =>
              value.user && (online || id === room.awareness.clientID),
          )
          .map(([id, value]) => ({
            id,
            name:
              typeof value.user.name === "string"
                ? value.user.name.slice(0, 32)
                : "Guest",
            local: id === room.awareness.clientID,
          }))
          .sort((a, b) => (a.local ? -1 : b.local ? 1 : a.id - b.id));
        const roster = JSON.stringify(list);
        if (previousRoster !== roster) {
          previousRoster = roster;
          setPeers(list);
        }
      };
      room.awareness.on("change", presence);
      stopPresence = () => room.awareness.off("change", presence);
      let checkedRevocation = false;
      stopState = room.subscribe((next) => {
        if (disposed) return;
        setState(next);
        surfaceRef.current?.setReadOnly(next.readOnly);
        presence();
        if (next.error?.code === "account_changed") {
          dispose();
          location.reload();
        } else if (
          next.error?.code === "access_changed" &&
          !checkedRevocation
        ) {
          checkedRevocation = true;
          void api<Session>("/api/session")
            .then((session) => {
              if (session.user?.id !== user.id) {
                dispose();
                location.reload();
              }
            })
            .catch(() => {});
        }
      });
      void room.connect().catch(() => {});
    })().catch((error) => {
      if (!disposed) setStartupError(explain(error));
    });
    return () => {
      dispose();
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("pagehide", dispose);
    };
  }, [kind, roomId, user.id, user.username, cleanupRef, unsavedRef]);

  const memberPath = `/api/rooms/${encodeURIComponent(roomId)}/members`;
  async function loadMembers() {
    if (!state.role || frozen) return;
    try {
      setMembers(
        (
          await api<{ data: { members: Member[] } }>(
            `/api/rooms/${encodeURIComponent(roomId)}`,
          )
        ).data.members,
      );
      setMembersLoaded(true);
      setMemberError("");
    } catch (error) {
      setMemberError(explain(error));
    }
  }
  useEffect(() => {
    if (state.role && !frozen) void loadMembers();
  }, [state.role, memberPath, frozen]);
  async function changeMember(username: string, nextRole: string | null) {
    setMemberPending(true);
    try {
      await api(
        `${memberPath}/${encodeURIComponent(username)}`,
        nextRole ? "PUT" : "DELETE",
        nextRole ? { role: nextRole } : undefined,
      );
      setMemberError("");
      await loadMembers();
    } catch (error) {
      setMemberError(explain(error));
    } finally {
      setMemberPending(false);
    }
  }
  function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void changeMember(String(data.get("username")), String(data.get("role")));
  }
  function toggle() {
    if (frozen) return location.reload();
    const room = roomRef.current;
    if (active) void room?.disconnect();
    else void room?.connect().catch(() => {});
  }
  const connectionLabel =
    labels[state.connection] ??
    (frozen
      ? "Access changed. Reload to check permissions."
      : state.error?.code === "unauthorized"
        ? "Access expired or denied"
        : state.error?.code === "timeout"
          ? "Connection timed out"
          : (errors[state.error?.code ?? ""] ??
            "Document sync failed. Keep this tab open."));
  const saveHelp =
    state.saveStatus === "failed"
      ? (errors[state.saveError ?? ""] ??
        "Save could not be confirmed. Disconnect and connect again to retry. Keep this tab open.")
      : state.hasUnsavedChanges
        ? "Keep this tab open until Saved appears. Offline edits stay in this tab until you reconnect."
        : "Saved edits stay in this room after everyone leaves.";

  const online = state.connection === "connected";
  const onlineNames = new Set(online ? peers.map((peer) => peer.name) : []);
  const roster = membersLoaded
    ? members.map((member) => ({ name: member.username, role: member.role }))
    : [...new Set(peers.map((peer) => peer.name))].map((name) => ({
        name,
        role: name === user.username ? state.role : null,
      }));
  const connectionAction = frozen
    ? "Reload"
    : active
      ? "Disconnect"
      : "Connect";
  const connectionHelp = online
    ? "You are online. Changes and presence are shared with everyone in this room."
    : frozen
      ? "Your access has changed. Reload to check your current permissions. Copy any unsaved draft before reloading."
      : state.connection === "error"
        ? "The room could not connect. Review the message above before trying again."
        : active
          ? "Connecting to the room. Your draft stays in this tab while the connection is restored."
          : "You are offline. Keep this tab open to preserve any unsaved edits.";
  const roomInfo = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline">
          <ShieldCheck data-icon="inline-start" />
          <span id="role-label">{state.role ?? "Checking access"}</span>
        </Badge>
        <span className="text-muted-foreground">
          {membersLoaded
            ? `${members.length} ${members.length === 1 ? "member" : "members"} · ${onlineNames.size} online`
            : "Loading members…"}
        </span>
      </div>
      <ul aria-label="Room members" className="flex flex-col gap-3">
        {roster.map((member) => (
          <li key={member.name} className="flex items-center gap-3">
            <Avatar className="size-8">
              <AvatarFallback>
                {member.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate">
                {member.name}
                {member.name === user.username ? " (you)" : ""}
              </p>
              {member.role ? (
                <p className="text-xs text-muted-foreground">{member.role}</p>
              ) : null}
            </div>
            <span
              className="member-presence"
              data-online={onlineNames.has(member.name)}
            >
              <span className="status-dot" />
              {onlineNames.has(member.name) ? "Online" : "Offline"}
            </span>
          </li>
        ))}
      </ul>
      {memberError ? (
        <Alert variant="destructive">
          <AlertDescription>{memberError}</AlertDescription>
        </Alert>
      ) : null}
      <Button variant="outline" asChild>
        <a
          id="open-peer"
          href={`${selected.path}?room=${encodeURIComponent(roomId)}`}
          target="_blank"
          rel="noopener"
        >
          <ExternalLink data-icon="inline-start" />
          Open this room in another tab
        </a>
      </Button>
    </>
  );
  const membersControl = (
    <Dialog
      onOpenChange={(open) => {
        if (open) void loadMembers();
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="members-trigger"
          aria-label="Manage access"
        >
          <span className="avatar-stack">
            {peers.slice(0, 3).map((peer) => (
              <Avatar key={peer.id} className="size-8">
                <AvatarFallback>
                  {peer.name.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            ))}
            {!peers.length ? <Users /> : null}
          </span>
          {peers.length > 3 ? (
            <span>+{peers.length - 3}</span>
          ) : (
            <Plus data-icon="inline-end" />
          )}
          <span id="participant-count" className="sr-only" aria-live="polite">
            {online ? `${peers.length} online` : "Offline"}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className="playground-dialog sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage access</DialogTitle>
          <DialogDescription>
            Choose who can view and edit{" "}
            <span className="break-all">{roomId}</span>.
          </DialogDescription>
        </DialogHeader>
        {state.role === "owner" && !frozen ? (
          <div id="members-panel">
            <ul id="members-list" className="mb-4 flex flex-col gap-3">
              {members.map((member) => (
                <li
                  key={member.username}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {member.username}
                  </span>
                  <NativeSelect
                    aria-label={`Role for ${member.username}`}
                    disabled={memberPending || frozen}
                    value={member.role}
                    onChange={(event) =>
                      void changeMember(member.username, event.target.value)
                    }
                  >
                    {["owner", "editor", "viewer"].map((role) => (
                      <NativeSelectOption key={role} value={role}>
                        {role}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={memberPending || frozen}
                    aria-label={`Remove ${member.username}`}
                    onClick={() => void changeMember(member.username, null)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <form id="member-form" onSubmit={grant}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="member-username">
                    Account username
                  </FieldLabel>
                  <Input
                    id="member-username"
                    name="username"
                    maxLength={32}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="member-role">Role</FieldLabel>
                  <NativeSelect
                    id="member-role"
                    name="role"
                    defaultValue="editor"
                  >
                    <NativeSelectOption value="editor">
                      Editor
                    </NativeSelectOption>
                    <NativeSelectOption value="viewer">
                      Viewer
                    </NativeSelectOption>
                    <NativeSelectOption value="owner">Owner</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Button disabled={memberPending || frozen}>
                  <Users data-icon="inline-start" />
                  Grant access
                </Button>
              </FieldGroup>
            </form>
            <p
              id="member-error"
              className="mt-2 text-sm text-destructive"
              role="alert"
            >
              {memberError}
            </p>
          </div>
        ) : (
          <>
            <p className="text-muted-foreground">
              Only room owners can change access. Ask an owner to invite someone
              or update your role.
            </p>
            {roomInfo}
          </>
        )}
      </DialogContent>
    </Dialog>
  );

  return (
    <>
      <PlaygroundHeader
        kind={kind}
        roomId={roomId}
        accountMenu={accountMenu}
        membersControl={membersControl}
        roomControl={
          <RoomDialog
            kind={kind}
            roomId={roomId}
            onOpen={() => void loadMembers()}
          >
            {roomInfo}
          </RoomDialog>
        }
      />
      <main
        id="collaboration"
        className={cn("playground-content", `${kind}-page`)}
        aria-label={`${selected.title} playground`}
      >
        {accountError}
        {startupError ? (
          <Alert variant="destructive">
            <AlertDescription>{startupError}</AlertDescription>
          </Alert>
        ) : null}
        <SurfaceHost title={selected.title} hint={selected.hint} />
      </main>
      <footer className="playground-footer">
        <div className="footer-connection">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Connection status">
                <span
                  className="status-dot connection-dot"
                  data-state={state.connection}
                  aria-hidden="true"
                />
                <span
                  id="status"
                  role="status"
                  className="truncate"
                  data-state={
                    state.connection === "error"
                      ? "error"
                      : online
                        ? "connected"
                        : active
                          ? "connecting"
                          : "disconnected"
                  }
                >
                  {connectionLabel}
                </span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Connection status</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="flex flex-col gap-3">
                    <p id="connection-label">{connectionLabel}</p>
                    <p>{connectionHelp}</p>
                    {state.hasUnsavedChanges ||
                    state.saveStatus === "failed" ? (
                      <p>{saveHelp}</p>
                    ) : null}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Close</AlertDialogCancel>
                <AlertDialogAction onClick={toggle}>
                  {connectionAction}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button id="connection" variant="ghost" size="xs" onClick={toggle}>
            {connectionAction}
          </Button>
        </div>
        <span className="playground-caption">Playground</span>
        <div className="footer-save">
          <Dialog>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Save status and help"
                aria-describedby="save-help"
              >
                {state.saveStatus === "saved" ? (
                  <Check data-icon="inline-start" />
                ) : (
                  <CircleHelp data-icon="inline-start" />
                )}
                <span id="save-status" aria-live="polite">
                  {saveLabels[state.saveStatus]}
                </span>
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{saveLabels[state.saveStatus]}</DialogTitle>
                <DialogDescription>{saveHelp}</DialogDescription>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                {selected.hint}. Undo affects your own changes.
              </p>
            </DialogContent>
          </Dialog>
          <span id="save-help" className="sr-only">
            {saveHelp}
          </span>
        </div>
      </footer>
      <ul id="participants" aria-label="Participants" className="sr-only">
        {peers.map((peer) => (
          <li key={peer.id}>
            {peer.name} ·{" "}
            {peer.local ? (online ? "You" : "You · offline") : "Online"}
          </li>
        ))}
      </ul>
      <span id="your-name" className="sr-only">
        {user.username}
      </span>
    </>
  );
}
