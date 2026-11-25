// Landing routing for a school link (docs/22 §3): role → class → instrument version.
// Driven entirely by the instrument registry (respondent_type, class_range) and by what the
// school's link allows (school_info). No instrument names are hard-coded here.

export interface IndexEntry {
  instrument_version_id: string;
  instrument_id: string;
  title: string;
  respondent_type: string;
  class_range: number[];
  status: string;
  system_fill?: Record<string, string>;
  file: string;
}

export interface SchoolInfo {
  ok: boolean;
  status: 'active' | 'not_yet_open' | 'closed' | 'unavailable';
  classes?: number[];
  instruments?: string[];
}

export type Role = 'student' | 'teacher';

function allowed(index: IndexEntry[], info: SchoolInfo, role: Role): IndexEntry[] {
  const ids = new Set(info.instruments ?? []);
  return index.filter((e) => e.respondent_type === role && ids.has(e.instrument_version_id));
}

/** Roles the link can offer (a school with no teacher instrument shows students only, etc.). */
export function rolesFor(index: IndexEntry[], info: SchoolInfo): Role[] {
  return (['student', 'teacher'] as Role[]).filter((r) => classChoices(index, info, r).length > 0);
}

export interface ClassChoice {
  /** Student: one class ("9"). Teacher: a band ("7-10"). Stored as route_class. */
  value: string;
  classes: number[];
  instrument: IndexEntry;
}

/**
 * Student: each class the school offers that some allowed student instrument covers.
 * Teacher: one choice per allowed teacher instrument, limited to the classes the school offers.
 */
export function classChoices(index: IndexEntry[], info: SchoolInfo, role: Role): ClassChoice[] {
  const offered = (info.classes ?? []).slice().sort((a, b) => a - b);
  const instruments = allowed(index, info, role);
  if (role === 'student') {
    const out: ClassChoice[] = [];
    for (const c of offered) {
      const inst = instruments.find((e) => e.class_range.includes(c));
      if (inst) out.push({ value: String(c), classes: [c], instrument: inst });
    }
    return out;
  }
  return instruments
    .map((inst) => {
      const classes = inst.class_range.filter((c) => offered.includes(c)).sort((a, b) => a - b);
      return { value: `${inst.class_range[0]}-${inst.class_range[inst.class_range.length - 1]}`, classes, instrument: inst };
    })
    .filter((c) => c.classes.length > 0)
    .sort((a, b) => a.classes[0] - b.classes[0]);
}
