# @deepseek-ai/dsh-host-local-files

English | [中文](README.zh.md)

Third-party vendor extension for DeepSeek Harness. The package name follows the Harness workspace convention and does not imply upstream support.

The plugin adds a separate generic-file lifecycle; it does not widen the image-only `ctx.attachments` contract. A raw `PUT /local-files/v1/import` body streams any browser `File` to the Harness host with backpressure, an incremental size limit, bounded prefix sniffing, and SHA-256 in the same pass. The completed payload and metadata are committed under the configured local storage root. No Base64 or multipart envelope is created.

Files are keyed to the session workspace but retained outside the repository under `$DSH_HOME/local-files`. A file reference contains only its UUID, name, media type, byte size, and reader kind. The model receives the short reference and may call `local_file_inspect`, `local_file_read`, `local_file_search`, or `local_file_read_bytes`; only the bounded tool result enters DeepSeek model context. Filename extensions are hints, never an admission allowlist. Unknown or unsafe-to-decode content is retained as `binary`.

## Config

| Key | Default | Meaning |
|---|---:|---|
| `storageRoot` | required | Absolute host-local staging root. |
| `trustedHosts` | `[]` | Non-loopback authorities accepted by the same-origin/DNS-rebinding fence. |
| `maxFileBytes` | 8 GiB | Maximum raw import size. |
| `maxReadRecords` | 200 | Maximum records returned by one paged read. |
| `maxReadBytes` | 64 KiB | Maximum model-facing read body. |
| `maxBinaryReadBytes` | 16 KiB | Maximum raw bytes returned by one byte-window call. |
| `maxRecordChars` | 8000 | Per-record character cap. |
| `maxSearchMatches` | 50 | Maximum search matches. |
| `maxSearchExcerptChars` | 600 | Search excerpt window. |

## Security and privacy

The import endpoint applies a Host, Fetch-Metadata, and Origin fence before reading the request body. Storage paths are derived from canonical workspace hashes plus UUIDs; browser filenames never become directory components. Payloads use owner-only modes and metadata appears only after the payload rename succeeds.

The raw file is not sent to the model provider. Text returned by a model-invoked read or search tool is normal model context and therefore is sent to the configured DeepSeek endpoint.

## Model Experience

### Local-file system prompt

#### What the model sees

The model sees one fixed prompt section at order 103 while the plugin is active.

##### Exact section

```markdown
A user message may contain <local_file> references. Use local_file_inspect first. Use local_file_read or local_file_search for supported text, CSV, XLSX, and DOCX content; use local_file_read_bytes only for a bounded byte window of other formats. Continue with next_start or next_offset when more data is needed. Do not claim to have reviewed the complete file unless the paged operation reached its end marker.
```

#### Token effect

The section adds a small fixed token cost to every request while the plugin is active.

#### KV Cache effect

The section is prefix-stable while the plugin version and composition are unchanged.

### File-reference message

#### What the model sees

Each attached file contributes only a short `<local_file id="…" name="…" size_bytes="…" />` marker in the user message; raw file bytes are absent. The model obtains the authoritative reader kind from `local_file_inspect`, not from browser-supplied metadata.

#### Token effect

Cost grows with the number and metadata length of file markers, not with raw file size.

#### KV Cache effect

The marker is ordinary append-only user content and does not alter the earlier reusable prefix.

### Local-file tools and results

#### What the model sees

The model can call `local_file_inspect`, `local_file_read`, `local_file_search`, and `local_file_read_bytes`. Record reads, searches, and encoded byte windows are capped; only those returned fragments enter model history.

#### Token effect

The four fixed definitions add stable tool tokens. Each call adds its arguments and a bounded result; later pages grow history incrementally.

#### KV Cache effect

Definitions remain prefix-stable while configuration is unchanged, and tool calls/results append after the reusable prefix.

## Known Limitations and Deferred Work

- The Web surface must copy the browser `File` to the Harness host because browser drag-and-drop does not expose an operating-system path. A future Electron/native transport can adopt or hard-link a path behind the same service and reference protocol.
- XLSX rows are streamed, but Excel's shared-string table is cached in memory; a later page also rescans the ZIP stream from the start.
- DOCX reads paragraph text only; tracked changes, comments, headers, footers, and embedded objects are not projected.
- Every format is stored, but only UTF-8 text, CSV/TSV, XLSX, and DOCX have semantic readers. Legacy Office, encrypted documents, PDF, archives, audio, video, and proprietary formats fall back to metadata plus bounded encoded bytes.
- Imported files remain until an operator removes the corresponding `$DSH_HOME/local-files` data; retention policy is deferred.
