import * as Y from "yjs";

export const textFields = [
  { id: "name", label: "Project name", placeholder: "Give your project a name", max: 120 },
  { id: "goal", label: "What are we making?", placeholder: "Describe the idea and the problem it solves…", max: 2000 },
  { id: "audience", label: "Who is it for?", placeholder: "Who will use it, and what do they need?", max: 1000 },
];
export const teams = ["Product", "Design", "Engineering", "Marketing", "Operations"];
export const priorities = ["Normal", "High", "Urgent"];
export const channels = ["Website", "Email", "Social", "In-app"];
export const requiredFields = [...textFields.map(field => field.id), "team"];

function validDate(value) {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validate(values) {
  const errors = {};
  for (const field of textFields) {
    if (!values[field.id].trim()) errors[field.id] = `${field.label} is required.`;
    else if (values[field.id].length > field.max) errors[field.id] = `Use ${field.max} characters or fewer.`;
  }
  if (!teams.includes(values.team)) errors.team = "Choose a team.";
  if (!validDate(values.date)) errors.date = "Choose a valid date.";
  return errors;
}

export function createFormModel(doc) {
  // Top-level names avoid competing initializations of nested shared text.
  const texts = Object.fromEntries(textFields.map(field => [field.id, doc.getText(`multiplayer-form:${field.id}:v1`)]));
  const properties = doc.getMap("multiplayer-form:properties:v1");
  const origin = {};
  const history = new Y.UndoManager([...Object.values(texts), properties], { trackedOrigins: new Set([origin]) });
  return {
    texts, properties, history,
    values() {
      return { ...Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, text.toString()])),
        team: teams.includes(properties.get("team")) ? properties.get("team") : "",
        priority: priorities.includes(properties.get("priority")) ? properties.get("priority") : "Normal",
        date: typeof properties.get("date") === "string" ? properties.get("date") : "",
        channels: channels.filter(channel => properties.get(`channel:${channel}`) === true),
      };
    },
    set(field, value) {
      const valid = field === "team" ? teams.includes(value) || value === ""
        : field === "priority" ? priorities.includes(value)
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
