"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowUpRight, FolderPlus, Hash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, explain, type RoomSummary } from "@/lib/api";
import { example, type ExampleKind } from "@/lib/examples";

export function RoomDialog({
  kind,
  roomId,
  rooms = [],
  children,
  trigger,
  defaultTab = "info",
  onOpen,
}: {
  kind: ExampleKind;
  roomId?: string | null;
  rooms?: RoomSummary[];
  children?: ReactNode;
  trigger?: ReactNode;
  defaultTab?: "info" | "create";
  onOpen?(): void;
}) {
  const selected = example(kind);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

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
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button
            variant="ghost"
            className="room-trigger"
            aria-label={roomId ? `Room details: ${roomId}` : "Choose a room"}
          >
            <span className="truncate">{roomId ?? "Choose a room"}</span>
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="playground-dialog sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rooms</DialogTitle>
          <DialogDescription>
            Share a room across all the playground examples.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={defaultTab}>
          <TabsList className="mb-4 w-full">
            <TabsTrigger value="info">Room info</TabsTrigger>
            <TabsTrigger value="create">Create a room</TabsTrigger>
          </TabsList>
          <TabsContent value="info" className="flex flex-col gap-5">
            {roomId ? (
              <>
                <div className="flex min-w-0 items-center gap-2">
                  <Hash className="size-4 shrink-0 text-muted-foreground" />
                  <h2 className="break-all font-medium">{roomId}</h2>
                </div>
                {children}
                <form method="get" id="room-form" action={selected.path}>
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
                      <FieldDescription>
                        An owner must grant access before you can open another
                        room.
                      </FieldDescription>
                    </Field>
                    <Button type="submit" variant="outline">
                      Open room
                    </Button>
                  </FieldGroup>
                </form>
                <Button asChild variant="link">
                  <a href={selected.path}>All rooms</a>
                </Button>
              </>
            ) : (
              <>
                <h2 className="font-medium">Your rooms</h2>
                {rooms.length ? (
                  <ul className="room-list">
                    {rooms.map((room) => (
                      <li key={room.id}>
                        <a
                          href={`${selected.path}?room=${encodeURIComponent(room.id)}`}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {room.id}
                          </span>
                          <Badge variant="outline">{room.role}</Badge>
                          <ArrowUpRight className="size-4 shrink-0" />
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">
                    No rooms yet. Create one in the next tab, or ask an owner to
                    invite you.
                  </p>
                )}
              </>
            )}
          </TabsContent>
          <TabsContent value="create">
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
                    Use letters, numbers, underscores, and hyphens. You will be
                    the room owner.
                  </FieldDescription>
                </Field>
                {error ? (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
                <Button disabled={pending} type="submit">
                  <FolderPlus data-icon="inline-start" />
                  {pending ? "Creating room…" : "Create room"}
                </Button>
              </FieldGroup>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
