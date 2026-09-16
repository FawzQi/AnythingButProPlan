/**
 * Append the user's additional instructions to the very end of a built prompt.
 *
 * Deliberately anchor-free: earlier versions inserted the block before the
 * `## Output Instructions` heading, which required the marker string to match
 * the template exactly. Any drift between the two (template reworded, marker
 * corrupted in an edit) made `indexOf` return -1 and the branch silently
 * changed behaviour. Appending unconditionally removes that coupling — the
 * block either lands at the bottom of the prompt or the custom text was empty.
 *
 * Returns the prompt untouched when either side is empty, so an unedited
 * textarea produces byte-identical output to the base prompt.
 */
export function insertCustomPrompt(prompt: string, custom: string): string {
  const trimmed = custom.trim()
  if (prompt === '' || trimmed === '') return prompt
  return `${prompt.trimEnd()}\n\n## Additional Instructions\n\n${trimmed}\n`
}
