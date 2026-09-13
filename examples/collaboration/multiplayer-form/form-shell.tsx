"use client";

import { Fragment, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { channels, priorities, teams, textFields } from "./model.ts";

interface ShellState {
  errors: Record<string, string>;
  readOnly: boolean;
  reviewing: boolean;
}

function FormField({ id, label, required = false, state, children }: {
  id: string; label: string; required?: boolean; state: ShellState; children: ReactNode;
}) {
  return <Field className="brief-field" data-field={id} data-invalid={Boolean(state.errors[id])} data-disabled={state.readOnly}>
    <div className="field-heading">
      <FieldLabel id={`label-${id}`} htmlFor={`field-${id}`}>
        {label}{required ? <span className="required-marker" aria-hidden="true"> *</span> : null}
      </FieldLabel>
      <span className="field-people" id={`people-${id}`} />
    </div>
    {children}
    <FieldError id={`error-${id}`}>{state.errors[id]}</FieldError>
  </Field>;
}

function FormShell({ state }: { state: ShellState }) {
  return <Fragment>
    <form className="shared-form" noValidate>
      <div className="brief-heading">
        <div><p className="eyebrow">PROJECT BRIEF</p><h2>Let&apos;s get on the same page.</h2><p className="note">A shared starting point for your next project.</p></div>
        <span id="brief-completion">0 of 4 complete</span>
      </div>
      <progress id="brief-progress" defaultValue={0} max={4} aria-label="Required fields completed" />
      <section className="brief-section" aria-labelledby="basics-heading">
        <h3 id="basics-heading"><span>01</span> The idea</h3>
        <FieldGroup id="text-fields">
          {textFields.map(spec => <FormField key={spec.id} id={spec.id} label={spec.label} required state={state}>
            {/* React owns the mount; CodeMirror alone owns its content. */}
            <div className={spec.id === "name" ? "brief-text brief-name" : "brief-text"} id={`editor-${spec.id}`} />
          </FormField>)}
        </FieldGroup>
      </section>
      <section className="brief-section" aria-labelledby="details-heading">
        <h3 id="details-heading"><span>02</span> The details</h3>
        <FieldGroup className="brief-grid" id="detail-fields">
          <FormField id="team" label="Team" required state={state}>
            <NativeSelect id="field-team" name="team" required disabled={state.readOnly} aria-invalid={Boolean(state.errors.team)} aria-describedby="people-team error-team">
              <NativeSelectOption value="">Choose a team</NativeSelectOption>
              {teams.map(team => <NativeSelectOption key={team} value={team}>{team}</NativeSelectOption>)}
            </NativeSelect>
          </FormField>
          <FormField id="priority" label="Priority" state={state}>
            <NativeSelect id="field-priority" name="priority" disabled={state.readOnly} aria-invalid={Boolean(state.errors.priority)} aria-describedby="people-priority error-priority">
              {priorities.map(priority => <NativeSelectOption key={priority} value={priority}>{priority}</NativeSelectOption>)}
            </NativeSelect>
          </FormField>
          <FormField id="date" label="Target date" state={state}>
            <Input id="field-date" name="date" type="date" disabled={state.readOnly} aria-invalid={Boolean(state.errors.date)} aria-describedby="people-date error-date" />
          </FormField>
        </FieldGroup>
      </section>
      <section className="brief-section" aria-labelledby="channels-heading">
        <h3 id="channels-heading"><span>03</span> Where it will live</h3>
        <FieldSet className="brief-field" data-field="channels" data-invalid={Boolean(state.errors.channels)} data-disabled={state.readOnly}>
          <FieldLegend id="label-channels" variant="label">Launch channels</FieldLegend>
          <span className="field-people" id="people-channels" />
          <FieldGroup className="channel-options" data-slot="checkbox-group">
            {channels.map(channel => <Field key={channel} orientation="horizontal" className="channel-option">
              <input id={`channel-${channel}`} type="checkbox" value={channel} disabled={state.readOnly} aria-describedby="people-channels error-channels" aria-invalid={Boolean(state.errors.channels)} />
              <FieldLabel htmlFor={`channel-${channel}`}>{channel}</FieldLabel>
            </Field>)}
          </FieldGroup>
          <FieldError id="error-channels">{state.errors.channels}</FieldError>
          <FieldDescription>Choose as many as you need. You can decide later.</FieldDescription>
        </FieldSet>
      </section>
      <div className="brief-actions">
        <p className="note">Changes save as you go. Review a live preview when you&apos;re ready.</p>
        <Button type="submit" disabled={state.reviewing}>Review brief</Button>
      </div>
      <p id="brief-announcement" role="status" />
    </form>
    <dialog className="brief-preview" aria-labelledby="preview-title">
      <div className="preview-heading">
        <div><p className="eyebrow">LIVE PREVIEW</p><h2 id="preview-title">Project brief</h2></div>
        <Button type="button" variant="outline" id="close-preview">Close preview</Button>
      </div>
      <p className="note">This preview updates as your team edits. It does not submit the form.</p>
      <dl id="preview-content" />
    </dialog>
  </Fragment>;
}

export function createFormShell(container: HTMLElement) {
  const root = createRoot(container);
  flushSync(() => root.render(<FormShell state={{ errors: {}, readOnly: true, reviewing: false }} />));
  return {
    update(state: ShellState) { root.render(<FormShell state={state} />); },
    destroy() { root.unmount(); },
  };
}
