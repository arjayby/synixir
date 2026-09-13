"use client";

import type { ReactNode } from "react";
import { Check, ChevronDown, LogOut, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { example, examples, type ExampleKind } from "@/lib/examples";
import type { User } from "@/lib/api";

export function AccountMenu({
  user,
  dark,
  onTheme,
  onSignOut,
}: {
  user: User | null;
  dark: boolean;
  onTheme(): void;
  onSignOut(): void;
}) {
  return user ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button id="account-bar" variant="ghost" aria-label="Account menu">
          <span id="account-name" className="truncate">
            {user.username}
          </span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>My account</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onTheme}>
            {dark ? <Sun /> : <Moon />}
            {dark ? "Use light theme" : "Use dark theme"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem id="sign-out" onSelect={onSignOut}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <Button
      variant="ghost"
      size="icon"
      onClick={onTheme}
      aria-label={dark ? "Use light theme" : "Use dark theme"}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

export function PlaygroundHeader({
  kind,
  roomId,
  roomControl,
  membersControl,
  accountMenu,
}: {
  kind: ExampleKind;
  roomId?: string | null;
  roomControl: ReactNode;
  membersControl?: ReactNode;
  accountMenu: ReactNode;
}) {
  const selected = example(kind);
  return (
    <header className="playground-header">
      <nav className="playground-location" aria-label="Playground navigation">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" aria-label="Select example">
              <selected.icon data-icon="inline-start" />
              <span className="example-name">{selected.title}</span>
              <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="start" sideOffset={12}>
            <DropdownMenuLabel>Examples</DropdownMenuLabel>
            <DropdownMenuGroup>
              {examples.map((item) => (
                <DropdownMenuItem asChild key={item.id}>
                  <a
                    href={
                      item.path +
                      (roomId ? `?room=${encodeURIComponent(roomId)}` : "")
                    }
                    aria-current={kind === item.id ? "page" : undefined}
                  >
                    <item.icon />
                    {item.title}
                    {kind === item.id ? <Check className="ml-auto" /> : null}
                  </a>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="location-divider" aria-hidden="true">
          /
        </span>
        {roomControl}
      </nav>
      <div className="playground-people">
        {membersControl}
        {accountMenu}
      </div>
    </header>
  );
}
