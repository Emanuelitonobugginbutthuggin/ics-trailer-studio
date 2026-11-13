import { completeLook } from '../look/look';
import { defaultFixup, defaultTimeline, newProject, type Project } from './schema';

const AUTOSAVE_KEY = 'ics-trailer-studio:autosave:v1';

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

/** Validates and repairs a parsed project file. Throws with a readable reason. */
export function parseProject(text: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  const p = data as Partial<Project>;
  if (!p || p.app !== 'ics-trailer-studio') throw new Error('This JSON file is not an ICS Trailer Studio project.');
  if (p.version !== 1) throw new Error(`Project version ${String(p.version)} is newer than this tool understands.`);
  const project = newProject();
  project.name = typeof p.name === 'string' ? p.name : project.name;
  project.scenes = (p.scenes ?? []).map((s) => ({ ...s, fixup: { ...defaultFixup(), ...s.fixup } }));
  project.videos = p.videos ?? [];
  project.timeline = { ...defaultTimeline(), ...p.timeline };
  project.look = completeLook(p.look);
  const sceneIds = new Set(project.scenes.map((s) => s.id));
  const videoIds = new Set(project.videos.map((v) => v.id));
  project.shots = (p.shots ?? [])
    .filter((s) => (s.type === 'splat' && sceneIds.has(s.sceneId)) || (s.type === 'video' && videoIds.has(s.videoId)))
    // fields added after stage 1 get their defaults
    .map((s) => ({ ...s, inTrailer: s.inTrailer ?? true, transition: s.transition ?? 'cut' }));
  return project;
}

/** Keeps the project (never media) in this browser so a reload loses nothing. */
export function autosave(project: Project) {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serializeProject(project));
  } catch {
    // storage unavailable or full: saving to a file still works
  }
}

export function loadAutosave(): Project | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    return text ? parseProject(text) : null;
  } catch {
    return null;
  }
}

export function clearAutosave() {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // nothing to clear
  }
}
