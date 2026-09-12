"use client";
import { inspectForTest } from "@/lib/browser-test";
import { memo, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { SynixirRoom, type RoomState } from "@synixir/client";
import { ExternalLink, ShieldCheck, Undo2, Redo2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
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
async function loadSurface(kind: ExampleKind): Promise<(room: SynixirRoom) => Surface> {
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
      return (room) => createEditor(room.doc.getText("content"), room.awareness);
    }
  }
}

const SurfaceHost = memo(function SurfaceHost({
  title,
  hint,
  roomId,
}: {
  title: string;
  hint: string;
  roomId: string;
}) {
  return (
    <section className="document-panel" aria-label={title}>
      <div className="editor-toolbar">
        <span id="document-title" className="document-title">
          {roomId}
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
        <span>{hint}</span>
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
}
export function Workspace({ kind, roomId, user, cleanupRef, unsavedRef }: Props) {
  const selected = example(kind);
  const [state, setState] = useState<RoomState>(initial);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [memberError, setMemberError] = useState("");
  const [startupError, setStartupError] = useState("");
  const [title, setTitle] = useState("");
  const roomRef = useRef<SynixirRoom | null>(null);
  const surfaceRef = useRef<Surface | null>(null);
  const frozen = state.error?.code === "access_changed" || state.error?.code === "account_changed";
  const active = ["connected", "connecting", "reconnecting"].includes(state.connection);

  useEffect(() => {
    let disposed = false;
    let stopState = () => {};
    let stopPresence = () => {};
    let stopTitle = () => {};
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
      stopTitle();
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
      const create = kind === "sdk" ? null : await loadSurface(kind);
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
      surfaceRef.current = create?.(room) ?? null;
      const settings = room.doc.getMap<string>("settings");
      if (kind === "sdk") {
        const changed = () => setTitle(settings.get("title") ?? "");
        settings.observe(changed);
        stopTitle = () => settings.unobserve(changed);
      }
      let previousRoster = "";
      const presence = () => {
        const online = room.state.connection === "connected";
        const list: Peer[] = [...room.awareness.getStates()]
          .filter(([id, value]) => value.user && (online || id === room.awareness.clientID))
          .map(([id, value]) => ({
            id,
            name: typeof value.user.name === "string" ? value.user.name.slice(0, 32) : "Guest",
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
        } else if (next.error?.code === "access_changed" && !checkedRevocation) {
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
    try {
      setMembers((await api<{ data: Member[] }>(memberPath)).data);
    } catch (error) {
      setMemberError(explain(error));
    }
  }
  useEffect(() => {
    if (state.role === "owner") void loadMembers();
  }, [state.role, memberPath]);
  async function changeMember(username: string, nextRole: string | null) {
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
          : (errors[state.error?.code ?? ""] ?? "Document sync failed. Keep this tab open."));
  const saveHelp =
    state.saveStatus === "failed"
      ? (errors[state.saveError ?? ""] ??
        "Save could not be confirmed. Disconnect and connect again to retry. Keep this tab open.")
      : state.hasUnsavedChanges
        ? "Keep this tab open until Saved appears. Offline edits stay in this tab until you reconnect."
        : "Saved edits stay in this room after everyone leaves.";

  return (
    <div id="collaboration" className={`${kind}-page flex flex-col gap-5`}>
      <div className="workspace-status">
        <div className="flex items-center gap-2">
          <Badge variant="outline">
            <ShieldCheck data-icon="inline-start" />
            <span id="role-label">{state.role ?? "Checking access"}</span>
          </Badge>
          <span id="save-status" className="text-sm text-muted-foreground" aria-live="polite">
            {saveLabels[state.saveStatus]}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span
            id="status"
            role="status"
            data-state={
              state.connection === "error"
                ? "error"
                : state.connection === "connected"
                  ? "connected"
                  : active
                    ? "connecting"
                    : "disconnected"
            }
          >
            {connectionLabel}
          </span>
          <Button id="connection" variant="outline" size="sm" onClick={toggle}>
            {frozen ? "Reload" : active ? "Disconnect" : "Connect"}
          </Button>
        </div>
      </div>
      {startupError && (
        <p role="alert" className="text-destructive">
          {startupError}
        </p>
      )}
      <div className="workspace-grid">
        <div className="min-w-0">
          {kind === "sdk" ? (
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  Shared settings
                </CardTitle>
                <CardDescription>
                  A small example of synchronized application state.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="sdk-title">Room title</FieldLabel>
                    <Input
                      id="sdk-title"
                      value={title}
                      disabled={state.readOnly}
                      onChange={(event) => {
                        if (!roomRef.current?.state.readOnly)
                          roomRef.current?.doc
                            .getMap<string>("settings")
                            .set("title", event.target.value);
                      }}
                    />
                  </Field>
                  <p id="sdk-state" role="status">
                    {state.connection} · {state.saveStatus}
                    {state.error ? ` · ${state.error.code}` : ""}
                  </p>
                  <Button id="sdk-connection" variant="outline" onClick={toggle}>
                    {active ? "Disconnect" : "Connect"}
                  </Button>
                </FieldGroup>
              </CardContent>
            </Card>
          ) : (
            <SurfaceHost title={selected.title} hint={selected.hint} roomId={roomId} />
          )}
          <p id="save-help" className="mt-3 text-xs text-muted-foreground">
            {saveHelp}
          </p>
        </div>
        <aside className="room-sidebar" aria-label="Room details">
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                Room
              </CardTitle>
              <CardDescription>A shared place for this work.</CardDescription>
            </CardHeader>
            <CardContent>
              <form method="get" id="room-form">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="room">Room ID</FieldLabel>
                    <Input
                      id="room"
                      name="room"
                      defaultValue={roomId}
                      maxLength={128}
                      pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
                      required
                    />
                  </Field>
                  <Button type="submit" variant="outline">
                    Open room
                  </Button>
                </FieldGroup>
              </form>
              <p className="mt-3 text-xs text-muted-foreground">
                An owner must grant access before someone can open this room.{" "}
                <a className="underline" href={selected.path}>
                  All rooms
                </a>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                <span className="flex items-center justify-between">
                  <span>In this room</span>
                  <span
                    id="participant-count"
                    className="text-xs font-normal text-muted-foreground"
                    aria-live="polite"
                  >
                    {state.connection === "connected" ? `${peers.length} online` : "Offline"}
                  </span>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul id="participants" aria-label="Participants" className="flex flex-col gap-3">
                {peers.map((peer) => (
                  <li key={peer.id} className="flex items-center gap-2">
                    <Avatar className="size-7">
                      <AvatarFallback>{peer.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="text-sm">{peer.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {peer.local
                        ? state.connection === "connected"
                          ? "You"
                          : "You · offline"
                        : "Online"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-muted-foreground">
                You appear as <strong id="your-name">{user.username}</strong>.
              </p>
            </CardContent>
          </Card>
          {state.role === "owner" && (
            <Card id="members-panel">
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  Manage access
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul id="members-list" className="mb-4 flex flex-col gap-3">
                  {members.map((member) => (
                    <li key={member.username} className="flex flex-wrap items-center gap-2">
                      <span className="w-full truncate text-sm">{member.username}</span>
                      <NativeSelect
                        aria-label={`Role for ${member.username}`}
                        value={member.role}
                        onChange={(event) => void changeMember(member.username, event.target.value)}
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
                      <FieldLabel htmlFor="member-username">Account username</FieldLabel>
                      <Input id="member-username" name="username" maxLength={32} required />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="member-role">Role</FieldLabel>
                      <NativeSelect id="member-role" name="role" defaultValue="editor">
                        <NativeSelectOption value="editor">Editor</NativeSelectOption>
                        <NativeSelectOption value="viewer">Viewer</NativeSelectOption>
                        <NativeSelectOption value="owner">Owner</NativeSelectOption>
                      </NativeSelect>
                    </Field>
                    <Button>
                      <Users data-icon="inline-start" />
                      Grant access
                    </Button>
                  </FieldGroup>
                </form>
                <p id="member-error" className="mt-2 text-sm text-destructive" role="alert">
                  {memberError}
                </p>
              </CardContent>
            </Card>
          )}
          <p id="editor-help" className="text-xs text-muted-foreground">
            {selected.hint}. Undo affects your own changes.
          </p>
          <a
            id="open-peer"
            href={`${selected.path}?room=${encodeURIComponent(roomId)}`}
            target="_blank"
            rel="noopener"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <ExternalLink className="size-3" />
            Open this room in another tab
          </a>
        </aside>
      </div>
    </div>
  );
}
