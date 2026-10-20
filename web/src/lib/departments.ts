import type { Department, User } from '@crewbox/shared'

/**
 * What "Add the usual ones" adds to a box with no departments: the ones
 * nearly every show has. One press, then rename or delete what doesn't fit,
 * rather than five empty forms (Default Effect).
 */
export const USUAL_DEPARTMENTS = ['Production', 'Stage', 'Lighting', 'Sound', 'Video'] as const

export interface CrewGroup {
  /** The department's id; null for the people in none. */
  id: string | null
  name: string | null
  people: User[]
}

/**
 * The crew in their departments, A to Z, with the people in none last.
 * Within each, whoever is online first, then by name. A department nobody
 * is in is left out: the Departments list is where it shows.
 *
 * Somebody whose department has just been deleted (their own row not yet
 * updated) is counted as in none, rather than under a heading that is gone.
 */
export function crewByDepartment(
  users: User[],
  departments: Record<string, Department>,
  online: Record<string, boolean>
): CrewGroup[] {
  const groups = new Map<string | null, User[]>()
  for (const user of users) {
    const id = user.departmentId && departments[user.departmentId] ? user.departmentId : null
    const list = groups.get(id) ?? []
    list.push(user)
    groups.set(id, list)
  }
  const byPresence = (a: User, b: User) =>
    Number(online[b.id] ?? false) - Number(online[a.id] ?? false) || a.name.localeCompare(b.name)
  return [...groups.entries()]
    .map(([id, people]) => ({
      id,
      name: id ? departments[id]!.name : null,
      people: people.sort(byPresence),
    }))
    .sort((a, b) => {
      if (a.name === null) return 1
      if (b.name === null) return -1
      return a.name.localeCompare(b.name)
    })
}
