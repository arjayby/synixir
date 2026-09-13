"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, FolderPlus, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import { example, type ExampleKind } from "@/lib/examples";
import {
  api,
  explain,
  sessionChanged,
  type User,
  type Session,
  type RoomSummary,
} from "@/lib/api";
import { AccountMenu, PlaygroundHeader } from "./playground-header";
import { RoomDialog } from "./room-dialog";
import { Workspace } from "./workspace/workspace";

export function ExampleApp({ kind }: { kind: ExampleKind }) {
  const selected = example(kind);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [dark, setDark] = useState(false);
  const cleanup = useRef<() => void>(() => {});
  const unsaved = useRef<() => boolean>(() => false);

  useEffect(() => {
    const controller = new AbortController();
    const id = new URL(location.href).searchParams.get("room");
    setRoomId(id);
    try {
      const value = localStorage.getItem("synixir:theme") === "dark";
      setDark(value);
      document.documentElement.classList.toggle("dark", value);
    } catch {
      /* Optional preference. */
    }
    void api<Session>("/api/session", "GET", undefined, controller.signal)
      .then(async (session) => {
        setUser(session.user);
        if (session.user && !id)
          setRooms(
            (
              await api<{ data: RoomSummary[] }>(
                "/api/rooms",
                "GET",
                undefined,
                controller.signal,
              )
            ).data,
          );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(explain(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const changed = (event: StorageEvent) => {
      if (event.key === "synixir:session-change") {
        cleanup.current();
        location.reload();
      }
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) location.reload();
    };
    window.addEventListener("storage", changed);
    window.addEventListener("pageshow", restored);
    return () => {
      controller.abort();
      window.removeEventListener("storage", changed);
      window.removeEventListener("pageshow", restored);
    };
  }, []);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement;
    setPending(true);
    setError("");
    try {
      await api(
        submitter.value === "register" ? "/api/accounts" : "/api/session",
        "POST",
        values,
      );
      sessionChanged();
      location.reload();
    } catch (error) {
      setError(explain(error));
      setPending(false);
    }
  }
  async function signOut() {
    if (
      unsaved.current() &&
      !confirm(
        "Sign out and discard unsaved changes? Copy your draft first if you need it.",
      )
    )
      return;
    try {
      await api("/api/session", "DELETE");
      cleanup.current();
      sessionChanged();
      location.reload();
    } catch (error) {
      setError(explain(error));
    }
  }
  function theme() {
    const value = !dark;
    setDark(value);
    document.documentElement.classList.toggle("dark", value);
    try {
      localStorage.setItem("synixir:theme", value ? "dark" : "light");
    } catch {
      /* Optional preference. */
    }
  }

  const accountMenu = (
    <AccountMenu user={user} dark={dark} onTheme={theme} onSignOut={signOut} />
  );
  const accountError = error ? (
    <Alert variant="destructive">
      <AlertDescription id="account-error">{error}</AlertDescription>
    </Alert>
  ) : (
    <span id="account-error" role="alert" />
  );

  return (
    <div className="playground-shell">
      {!loading && user && roomId ? (
        <Workspace
          key={`${kind}:${roomId}:${user.id}`}
          kind={kind}
          roomId={roomId}
          user={user}
          cleanupRef={cleanup}
          unsavedRef={unsaved}
          accountMenu={accountMenu}
          accountError={accountError}
        />
      ) : (
        <>
          <PlaygroundHeader
            kind={kind}
            roomId={roomId}
            accountMenu={accountMenu}
            roomControl={
              user ? (
                <RoomDialog kind={kind} rooms={rooms} />
              ) : (
                <span className="signed-out-room">
                  {roomId ?? "Playground"}
                </span>
              )
            }
          />
          <main className="playground-content playground-lobby">
            <div className="lobby-content">
              <div className="lobby-heading">
                <p className="eyebrow">SYNIXIR PLAYGROUND</p>
                <h1>{user ? "Your rooms" : selected.title}</h1>
                <p>
                  {user
                    ? "Choose a room or create one to start exploring."
                    : selected.description}
                </p>
              </div>
              {accountError}
              {loading ? (
                <div
                  className="flex flex-col gap-5"
                  aria-label="Loading playground"
                >
                  <Skeleton className="h-12 w-64" />
                  <Skeleton className="h-64 w-full" />
                </div>
              ) : !user ? (
                <Card id="auth-panel">
                  <CardHeader>
                    <CardTitle role="heading" aria-level={2}>
                      Welcome to your shared workspace
                    </CardTitle>
                    <CardDescription>
                      Sign in or create an account to start collaborating.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <form id="auth-form" onSubmit={authenticate}>
                      <FieldGroup>
                        <Field>
                          <FieldLabel htmlFor="account-username">
                            Username
                          </FieldLabel>
                          <Input
                            id="account-username"
                            name="username"
                            autoComplete="username"
                            minLength={3}
                            maxLength={32}
                            pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}"
                            required
                            placeholder="Your public username"
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="account-password">
                            Password
                          </FieldLabel>
                          <Input
                            id="account-password"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            minLength={15}
                            maxLength={128}
                            required
                            placeholder="At least 15 characters"
                          />
                          <FieldDescription>
                            Use at least 15 characters. Usernames use letters,
                            numbers, underscores or hyphens.
                          </FieldDescription>
                        </Field>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="submit"
                            value="login"
                            disabled={pending}
                          >
                            Sign in
                            <ArrowUpRight data-icon="inline-end" />
                          </Button>
                          <Button
                            type="submit"
                            value="register"
                            variant="outline"
                            disabled={pending}
                          >
                            Create account
                          </Button>
                        </div>
                      </FieldGroup>
                    </form>
                  </CardContent>
                  <CardFooter>
                    <p className="text-xs text-muted-foreground">
                      Your account works across every example.
                    </p>
                  </CardFooter>
                </Card>
              ) : (
                <section id="rooms-panel" className="flex flex-col gap-6">
                  {rooms.length ? (
                    <ul id="room-list" className="room-list">
                      {rooms.map((room) => (
                        <li key={room.id}>
                          <a
                            href={`${selected.path}?room=${encodeURIComponent(room.id)}`}
                            aria-label={`${room.id} · ${room.role}`}
                          >
                            <selected.icon className="size-4 shrink-0" />
                            <span className="min-w-0 flex-1 truncate">
                              {room.id}
                            </span>
                            <Badge variant="outline">{room.role}</Badge>
                            <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <FolderPlus />
                        </EmptyMedia>
                        <EmptyTitle>No rooms yet</EmptyTitle>
                        <EmptyDescription>
                          Create a room, or ask an owner to invite you.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                  <RoomDialog
                    kind={kind}
                    rooms={rooms}
                    defaultTab="create"
                    trigger={
                      <Button>
                        <FolderPlus data-icon="inline-start" />
                        Create a room
                      </Button>
                    }
                  />
                </section>
              )}
            </div>
          </main>
          <footer className="playground-footer">
            <span className="footer-connection">
              <WifiOff className="size-3.5" />
              Offline
            </span>
            <span className="playground-caption">Playground</span>
            <span className="footer-save">
              {user ? "Open a room to start" : "Sign in to collaborate"}
            </span>
          </footer>
        </>
      )}
    </div>
  );
}
