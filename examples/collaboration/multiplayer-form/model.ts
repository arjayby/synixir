import * as Y from "yjs";

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

export function validate(values: Omit<FormValues, "priority" | "channels"> & Partial<Pick<FormValues, "priority" | "channels">>) {
  const errors: Record<string, string> = {};
  for (const field of textFields) {
    if (!values[field.id].trim()) errors[field.id] = `${field.label} is required.`;
    else if (values[field.id].length > field.max) errors[field.id] = `Use ${field.max} characters or fewer.`;
  }
  if (!teams.includes(values.team)) errors.team = "Choose a team.";
  if (!validDate(values.date)) errors.date = "Choose a valid date.";
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
