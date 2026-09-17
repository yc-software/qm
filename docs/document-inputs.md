# Conversation document inputs

Inbound attachments are read from the authorized artifact store and included in model input on the first turn and follow-ups, including after compaction. No model tool call is needed to locate or parse supported attachments. Filename extensions and supported MIME types identify documents. Images continue through the existing image input path.

| Route                                   | Native input                                                                                          | Other documents                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| OpenAI Responses                        | PDF, Word, Excel, PowerPoint, ODT, text and code                                                      | ODS, ODP and RTF use text extraction  |
| Anthropic Messages and Claude SDK       | PDF and plain-text document blocks                                                                    | Text extraction                       |
| OpenAI Chat Completions                 | PDF with vision models                                                                                | Text extraction                       |
| OpenRouter Chat Completions             | PDF on vision-capable OpenAI, Anthropic and Google models, with the native parser explicitly selected | Text extraction                       |
| Gemini and Vertex                       | PDF with vision models                                                                                | Text extraction                       |
| OpenCode                                | PDF on OpenAI, Anthropic and Google providers                                                         | Text extraction                       |
| QM gateways                             | Responses files for OpenAI/Azure groups; native PDFs for verified provider families                   | Text extraction for unknown providers |
| Codex app-server and other model routes | No assumed native document capability                                                                 | Text extraction                       |

PDF native inputs retain page visuals. Non-PDF OpenAI file inputs extract text; embedded images and charts are not preserved. OpenAI spreadsheet processing covers up to the first 1,000 rows per sheet, with additional metadata. Native support remains subject to the selected model, provider limits, document encryption and document validity. See the [OpenAI file input documentation](https://developers.openai.com/api/docs/guides/file-inputs), [Anthropic PDF documentation](https://platform.claude.com/docs/en/build-with-claude/pdf-support), [Gemini document documentation](https://ai.google.dev/gemini-api/docs/document-processing), and [OpenRouter PDF documentation](https://openrouter.ai/docs/guides/overview/multimodal/pdfs).

Text fallback handles UTF-8 text/code, CSV, TSV, PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP and RTF. It explicitly identifies missing images/charts, empty extraction, truncation, unsupported formats and malformed documents. Legacy DOC/XLS/PPT and Pages/Keynote require a supporting native route or conversion. Scanned PDFs require a native visual route or OCR; text fallback does not pretend to read them.

At most ten documents and 8 MB of original bytes are included per turn, newest attachments first. Extraction runs in cancellable workers with a ten-second deadline, memory and decompression limits. Each extraction is capped at 200,000 characters and combined fallback input at 100,000 characters. Pi routes further constrain text to the remaining model context. Binary provider inputs remain subject to provider page and token limits.

Authorization and integrity checks run on every turn. Document content is untrusted data; the external-data security policy applies when enabled. Unscreenable visuals remain marked unscreened. Stored conversation tape does not duplicate the injected document bytes or extracted text; authorized documents are rehydrated from their artifact references.

## QA

The checked-in fixtures contain synthetic verification markers. Format tests exercise genuine PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, ODT/ODS/ODP, RTF, TXT, Markdown, CSV/TSV, JSON, XML, HTML, YAML, Python, JavaScript, TypeScript, CSS, SQL, EML, ICS, VCF, SRT and VTT files. Additional cases cover scanned/malformed PDFs, hostile instructions, MIME-only filenames, byte/context limits, cancellation, revoked authorization, failed historical reads, follow-ups, compaction and tape redaction.

Provider serialization tests verify request shape and byte preservation; they do not establish live provider acceptance. Before release, run real model calls for each enabled native route with its credentials, including scanned PDFs and unsupported/encrypted files. Check both initial uploads and follow-ups through web and Slack, verify each independent marker, inspect tool calls, and record latency separately from sandbox startup.

## Recorded development validation

The browser upload flow on the Codex text fallback route recovered all 26 format-specific markers in PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, RTF and the 18 text/data fixtures. An eight-document follow-up recovered the same markers without reuploading. A mixed batch retained all readable documents and explicitly reported scanned and malformed PDFs unavailable. These turns made no model tool calls.

A real Claude SDK request using the same document-block builder recovered the native text-PDF and scanned-PDF markers, plus DOCX/XLSX/PPTX text fallback and a native plain-text document, in 8.0 seconds end to end. This is a small-fixture smoke test, not a latency guarantee.

OpenRouter-specific native acceptance and the Slack upload matrix remain release QA requirements. Local schema tests do not substitute for these checks.

The development Slack bot also passed a Firefox browser message/reply smoke test. The document upload matrix still needs to run through Slack; the native file chooser prevented completing that check in this session. Final affected validation: 162 passed, one skipped, zero failed; TypeScript, changed-file lint and lockfile dry-run checks passed. Independent review found no remaining code blockers.

Authenticated LiteLLM checks verified scanned PDF comprehension on Anthropic Messages and OpenAI/Gemini Chat Completions. OpenAI Responses read 26 native fixtures across office, legacy office and text formats; RTF used text fallback after the provider accepted its file but returned no readable content. Explicit filename labels preserve attachment identity when provider extraction omits filename metadata. Text MIME types are normalized to accepted wire types; these checks caught rejected XML and TypeScript labels that serialization tests had missed. Gateway discovery selects Responses for OpenAI/Azure groups and retains provider-based document capabilities, so unknown vision models do not inherit assumed PDF support.

A live Pi gateway session using discovered OpenAI metadata also passed a read-tool round trip, a follow-up retaining the tool result without another call, and native scanned-PDF comprehension without tools. The measured turns took 5.6, 1.6 and 2.2 seconds respectively. After the gateway fixes, 99 affected tests, TypeScript and changed-file lint passed.

Encrypted PDF fallback was verified to report unavailable content without revealing its verification marker. Native OpenAI requests rejected encrypted and malformed PDFs with HTTP 400 `invalid_file`; they require an unlocked, valid replacement. Native validation errors currently fail the request, including when a bad attachment accompanies readable files.
