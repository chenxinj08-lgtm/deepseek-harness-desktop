/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */

import type { ContentBlock, LocalFileBlock } from './types.ts'

/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}

/**
 * Render one local-file block into the bounded wire reference the model sees.
 * Only the validated UUID and host-detected media type are exposed; the file
 * name, byte count, and kind stay behind the `local_file_inspect` tool so a
 * hostile file name cannot inject instructions into the prompt.
 * @param block - host-resolved local-file block.
 * @returns a self-contained `<local_file …/>` reference.
 */
export function serializeLocalFileBlock(block: LocalFileBlock): string {
  return `<local_file id="${block.id}" media_type="${block.mediaType}"/>`
}

/**
 * Flatten user/assistant content into the single text string a text-only
 * provider receives. Text blocks contribute verbatim; local-file blocks become
 * bounded references. Tool-result blocks are deliberately NOT folded here:
 * their content is emitted by the caller's explicit tool-result path, so a
 * user message carrying tool results never leaks tool output into its text
 * (which would insert a user message between the assistant tool_calls and the
 * tool reply and break the wire pairing). Image blocks are intentionally not
 * represented here either (callers gate them first).
 * @param blocks - typed model content blocks.
 * @returns the joined provider-facing text.
 */
export function flattenModelText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'local-file':
        parts.push(serializeLocalFileBlock(block))
        break
      default:
        break
    }
  }
  return parts.join('')
}
