"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  ChevronRight,
  CircleHelp,
  FolderPlus,
  LogOut,
  Moon,
  Sun,
  Users,
  Zap,
} from "lucide-react";
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
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { example, examples, type ExampleKind } from "@/lib/examples";
import { api, explain, sessionChanged, type User, type Session, type RoomSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
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
            (await api<{ data: RoomSummary[] }>("/api/rooms", "GET", undefined, controller.signal))
              .data,
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
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement;
    setPending(true);
    setError("");
    try {
      await api(submitter.value === "register" ? "/api/accounts" : "/api/session", "POST", values);
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
      !confirm("Sign out and discard unsaved changes? Copy your draft first if you need it.")
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
  async function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const result = await api<{ data: { id: string } }>(
        "/api/rooms",
        "POST",
        Object.fromEntries(new FormData(event.currentTarget)),
      );
      location.href = `${selected.path}?room=${encodeURIComponent(result.data.id)}`;
    } catch (error) {
      setError(explain(error));
      setPending(false);
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

  return (
    <div className="app-frame">
      <aside className="app-sidebar" aria-label="Application navigation">
        <a href={selected.path} aria-label="Synixir home" className="brand">
          <span className="brand-mark">
            <Zap className="size-5" />
          </span>
          <span>
            Synixir<span className="brand-caption">A space to work together</span>
          </span>
        </a>
        <div className="sidebar-section">Workspace</div>
        <a className="sidebar-home" href={selected.path}>
          <Users className="size-4" />
          My rooms
          <ChevronRight className="ml-auto size-3" />
        </a>
        <div className="sidebar-section mt-8">Explore examples</div>
        <nav className="example-navigation" aria-label="Examples">
          {examples.map((item) => (
            <a
              key={item.id}
              href={item.path + (roomId ? `?room=${encodeURIComponent(roomId)}` : "")}
              aria-label={`Try ${item.title === "Text editor" ? "the text editor" : item.title === "Kanban board" ? "the Kanban board" : item.title === "Project brief" ? "the multiplayer form" : item.title === "Rich text" ? "rich text" : item.title === "Flowchart" ? "the flowchart builder" : item.title === "Table" ? "the collaborative table" : item.title === "Whiteboard" ? "the whiteboard" : "shared settings"}`}
              aria-current={kind === item.id ? "page" : undefined}
              className={cn("nav-item", kind === item.id && "nav-item-active")}
            >
              <item.icon className="size-4" />
              <span>{item.title}</span>
              {kind === item.id && <span className="nav-dot" />}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Separator />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CircleHelp className="size-4" />
            Changes are shared in real time.
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Make room for good work.</span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={theme}
              aria-label={dark ? "Use light theme" : "Use dark theme"}
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Workspace</span>
            <ChevronRight className="size-3" />
            <span className="text-foreground">{selected.title}</span>
          </div>
          {user ? (
            <div id="account-bar" className="flex items-center gap-3">
              <Avatar className="size-7">
                <AvatarFallback>{user.username.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span id="account-name" className="text-sm">
                {user.username}
              </span>
              <Button id="sign-out" variant="ghost" size="sm" onClick={signOut}>
                <LogOut data-icon="inline-start" />
                Sign out
              </Button>
            </div>
          ) : (
            <Badge variant="outline">Live collaboration</Badge>
          )}
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">BETTER TOGETHER</p>
              <h1>{selected.title}</h1>
              <p className="page-description">{selected.description}</p>
            </div>
            <Badge variant="secondary">
              <span className="presence-dot" />
              Shared in real time
            </Badge>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription id="account-error">{error}</AlertDescription>
            </Alert>
          )}
          {!error && <span id="account-error" role="alert" />}
          {loading ? (
            <div className="grid gap-5" aria-label="Loading workspace">
              <Skeleton className="h-12 w-64" />
              <Skeleton className="h-80 w-full" />
            </div>
          ) : !user ? (
            <div className="welcome-grid">
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
                        <FieldLabel htmlFor="account-username">Username</FieldLabel>
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
                        <FieldLabel htmlFor="account-password">Password</FieldLabel>
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
                          Use at least 15 characters. Usernames use letters, numbers, underscores or
                          hyphens.
                        </FieldDescription>
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        <Button type="submit" value="login" disabled={pending}>
                          Sign in
                          <ArrowUpRight data-icon="inline-end" />
                        </Button>
                        <Button type="submit" value="register" variant="outline" disabled={pending}>
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
              <div className="welcome-note">
                <div className="welcome-art" aria-hidden="true">
                  <div className="art-card art-card-back" />
                  <div className="art-card">
                    <selected.icon className="size-8" />
                    <div className="art-line" />
                    <div className="art-line short" />
                    <div className="art-avatars">
                      <span>A</span>
                      <span>B</span>
                      <span>+1</span>
                    </div>
                  </div>
                </div>
                <h2>A little less back-and-forth.</h2>
                <p>
                  Write, plan, and build alongside your team. Everyone sees changes as they happen.
                </p>
              </div>
            </div>
          ) : roomId ? (
            <Workspace
              key={`${kind}:${roomId}:${user.id}`}
              kind={kind}
              roomId={roomId}
              user={user}
              cleanupRef={cleanup}
              unsavedRef={unsaved}
            />
          ) : (
            <section id="rooms-panel" className="flex flex-col gap-8">
              <div className="rooms-grid">
                <Card>
                  <CardHeader>
                    <CardTitle role="heading" aria-level={2}>
                      Your rooms
                    </CardTitle>
                    <CardDescription>Pick up where you left off.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {rooms.length ? (
                      <ul id="room-list" className="room-list">
                        {rooms.map((room) => (
                          <li key={room.id}>
                            <a
                              href={`${selected.path}?room=${encodeURIComponent(room.id)}`}
                              aria-label={`${room.id} · ${room.role}`}
                            >
                              <span className="room-icon">
                                <selected.icon className="size-4" />
                              </span>
                              <span>{room.id}</span>
                              <Badge variant="outline">{room.role}</Badge>
                              <ArrowUpRight className="ml-auto size-4 text-muted-foreground" />
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
                          <EmptyTitle>A fresh start</EmptyTitle>
                          <EmptyDescription>
                            Create your first room, or ask an owner to invite you.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle role="heading" aria-level={2}>
                      Create a room
                    </CardTitle>
                    <CardDescription>Give your shared work a place of its own.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <form id="create-room-form" onSubmit={createRoom}>
                      <FieldGroup>
                        <Field>
                          <FieldLabel htmlFor="new-room">New room ID</FieldLabel>
                          <Input
                            id="new-room"
                            name="room_id"
                            maxLength={128}
                            pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
                            required
                            placeholder="e.g. product-planning"
                          />
                          <FieldDescription>
                            Letters, numbers, underscores, and hyphens.
                          </FieldDescription>
                        </Field>
                        <Button disabled={pending}>
                          <FolderPlus data-icon="inline-start" />
                          Create room
                        </Button>
                      </FieldGroup>
                    </form>
                  </CardContent>
                </Card>
              </div>
              <div>
                <div className="section-heading">
                  <h2>One room. Many ways to work.</h2>
                  <span>Try an example</span>
                </div>
                <div className="examples-grid">
                  {examples
                    .filter((item) => item.id !== kind)
                    .map((item) => (
                      <a href={item.path} className="example-card" key={item.id}>
                        <item.icon className="size-5" />
                        <h3>{item.title}</h3>
                        <p>{item.description}</p>
                        <ArrowUpRight className="example-arrow size-4" />
                      </a>
                    ))}
                </div>
              </div>
            </section>
          )}
        </main>
        <footer className="app-footer">
          <span>Synixir</span>
          <span>Shared work, saved as you go.</span>
        </footer>
      </div>
    </div>
  );
}
