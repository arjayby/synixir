import { createFormControl } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { Doc, Transaction } from "yjs";
import { briefSchema, type createFormModel, type FormValues } from "./model.ts";

export type FormFieldName = keyof FormValues;

export function createBriefFormState(doc: Doc, model: ReturnType<typeof createFormModel>) {
  const control = createFormControl<FormValues>({
    defaultValues: model.values(),
    resolver: zodResolver(briefSchema, undefined, { mode: "sync" }),
    shouldFocusError: false,
  });
  const names = Object.keys(model.values()) as FormFieldName[];
  for (const name of names) control.register(name);
  let submitted = false;
  const unsubscribe = control.subscribe({
    formState: { isSubmitted: true, touchedFields: true, dirtyFields: true, errors: true },
    callback: state => { submitted = state.isSubmitted ?? submitted; },
  });

  function syncDraft(transaction: Transaction) {
    const next = model.values();
    const current = control.getValues();
    const revalidate: FormFieldName[] = [];
    for (const name of names) {
      if (JSON.stringify(current[name]) === JSON.stringify(next[name])) continue;
      // This mirror never resets or writes to an editor. Yjs remains the shared
      // source, including drafts that cannot pass the review schema yet.
      control.setValue(name, next[name], { shouldDirty: transaction.local });
      if (submitted || control.getFieldState(name).isTouched) revalidate.push(name);
    }
    // Validate after every changed value is mirrored, so cross-field rules see
    // one complete transaction rather than a partly updated form.
    if (revalidate.length) void control.trigger(revalidate);
  }
  doc.on("afterTransaction", syncDraft);

  return {
    control,
    touch(name: FormFieldName) {
      control.setValue(name, model.values()[name], { shouldTouch: true, shouldValidate: true });
    },
    destroy() {
      doc.off("afterTransaction", syncDraft);
      unsubscribe();
    },
  };
}
