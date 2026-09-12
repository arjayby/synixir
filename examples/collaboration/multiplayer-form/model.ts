import * as Y from "yjs";
import { z } from "zod";

export interface FormValues { name: string; goal: string; audience: string; team: string; date: string; priority: string; channels: string[] }
export const textFields = [
  { id: "name", label: "Project name", placeholder: "Give your project a name", max: 120 },
  { id: "goal", label: "What are we making?", placeholder: "Describe the idea and the problem it solves…", max: 2000 },
  { id: "audience", label: "Who is it for?", placeholder: "Who will use it, and what do they need?", max: 1000 },
] as const;
export const teams = ["Product", "Design", "Engineering", "Marketing", "Operations"];
export const priorities = ["Normal", "High", "Urgent"];
export const channels = ["Website", "Email", "Social", "In-app"];
export const requiredFields = [...textFields.map(field => field.id), "team"];

function validDate(value: string) {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const textSchema = (field: typeof textFields[number]) => z.string()
  .refine(value => value.trim().length > 0, `${field.label} is required.`)
  .max(field.max, `Use ${field.max} characters or fewer.`);

// This schema validates a reviewable brief. Shared Y.Text drafts deliberately
// accept incomplete and over-limit text, and validation never rewrites it.
export const briefSchema = z.object({
  name: textSchema(textFields[0]),
  goal: textSchema(textFields[1]),
  audience: textSchema(textFields[2]),
  team: z.string().refine(value => teams.includes(value), "Choose a team."),
  date: z.string().refine(validDate, "Choose a valid date."),
  priority: z.string().refine(value => priorities.includes(value), "Choose a priority."),
  channels: z.array(z.string().refine(value => channels.includes(value), "Choose a launch channel.")),
});

export function validate(values: Omit<FormValues, "priority" | "channels"> & Partial<Pick<FormValues, "priority" | "channels">>) {
  const result = briefSchema.safeParse({ priority: "Normal", channels: [], ...values });
  const errors: Record<string, string> = {};
  if (!result.success) for (const issue of result.error.issues) {
    const field = String(issue.path[0]);
    errors[field] ??= issue.message;
  }
  return errors;
}

export function createFormModel(doc: Y.Doc) {
  // Top-level names avoid competing initializations of nested shared text.
  const texts = Object.fromEntries(textFields.map(field => [field.id, doc.getText(`multiplayer-form:${field.id}:v1`)]));
  const properties = doc.getMap("multiplayer-form:properties:v1");
  const origin = {};
  const history = new Y.UndoManager([...Object.values(texts), properties], { trackedOrigins: new Set([origin]) });
  return {
    texts, properties, history,
    values(): FormValues {
      return { name: texts.name.toString(), goal: texts.goal.toString(), audience: texts.audience.toString(),
        team: teams.includes(String(properties.get("team"))) ? String(properties.get("team")) : "",
        priority: priorities.includes(String(properties.get("priority"))) ? String(properties.get("priority")) : "Normal",
        date: typeof properties.get("date") === "string" ? String(properties.get("date")) : "",
        channels: channels.filter(channel => properties.get(`channel:${channel}`) === true),
      };
    },
    set(field: string, value: unknown) {
      const valid = field === "team" ? (typeof value === "string" && teams.includes(value)) || value === ""
        : field === "priority" ? (typeof value === "string" && priorities.includes(value))
          : field === "date" ? typeof value === "string" && validDate(value)
            : field.startsWith("channel:") && channels.includes(field.slice(8)) && typeof value === "boolean";
      if (!valid || properties.get(field) === value) return;
      history.stopCapturing();
      doc.transact(() => properties.set(field, value), origin);
      history.stopCapturing();
    },
    destroy() { history.destroy(); },
  };
}
