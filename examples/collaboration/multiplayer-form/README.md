# Multiplayer form

This example uses React Hook Form `7.88.0`, `@hookform/resolvers` `5.9.1`, and Zod `4.6.2` for local form state and validation. Synixir and Yjs still synchronize and save the project brief.

`form-state.ts` uses React Hook Form's [`createFormControl`](https://react-hook-form.com/docs/createFormControl) API because the workspace mounts examples through an imperative room lifecycle. The adapter registers each field, mirrors completed Yjs transactions with `setValue`, and keeps touched, dirty, and error state local. `form-shell.tsx` renders the existing shadcn Field components around stable CodeMirror mounts.

The Zod `briefSchema` describes a brief that can be reviewed. It checks required text, length limits, the selected team and priority, calendar dates, and launch channels. It does not trim or reject shared text while people type. Errors appear after leaving a field or choosing **Review brief**. A remote correction revalidates an already touched field without marking untouched fields as edited. Reviewing opens a live preview and writes nothing to the shared document.

Each text field retains its existing `multiplayer-form:<field>:v1` Y.Text and `y-codemirror.next` binding. React and React Hook Form never replace editor text, so character merging, relative cursor positions, selections, and undo remain with Yjs. Each launch channel retains its own map key, allowing independent offline choices to merge. The room permission callback blocks mutations and history immediately when access changes; it also updates the displayed disabled state.

From the repository root, run:

```sh
node --import tsx --test examples/collaboration/multiplayer-form/model.test.ts
npm run typecheck
npm run build
npm run test:browser -- multiplayer-form.spec.ts placeholder-cursors.spec.ts
```

The browser tests cover concurrent edits, field presence, local undo, offline merging, persistence after a server restart, validation, preview updates, viewer restrictions, revocation, placeholder cursors, stable editor elements, and mobile layout.
