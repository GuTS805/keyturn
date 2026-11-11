import { createHash } from 'node:crypto';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * "npm:leftpad@1.0.0"      -> { project: "npm:leftpad", version: "1.0.0" }
 * "npm:@acme/util@2.0.0"   -> { project: "npm:@acme/util", version: "2.0.0" }
 * "npm:leftpad"            -> { project: "npm:leftpad", version: undefined }
 */
export function parseTarget(text) {
  const colon = text.indexOf(':');
  if (colon < 1) throw new Error(`"${text}" must look like npm:name@version`);
  const at = text.lastIndexOf('@');
  if (at > colon + 1) return { project: text.slice(0, at), version: text.slice(at + 1) };
  return { project: text, version: undefined };
}

/** "npm:@acme/util" -> { registry: "npm", name: "@acme/util" } */
export function splitProject(project) {
  const colon = project.indexOf(':');
  return { registry: project.slice(0, colon), name: project.slice(colon + 1) };
}

export function encodePackageName(name) {
  return name.replace('/', '%2f');
}

export function hours(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) throw new Error('hours must be a non-negative number');
  return Math.round(v * 60 * 60 * 1000);
}
