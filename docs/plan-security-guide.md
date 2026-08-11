# Plan Security Guide

Plans are data, never executable code. The validator rejects arbitrary JavaScript,
shell/import fields, unsafe URLs, unsupported actions, and automatic CSS/XPath.
The runner enforces allowed origins, production mutation policy, a 1 MiB
accepted-payload limit before JSON parsing, assertions, or evidence persistence,
case isolation, cleanup, evidence redaction, and trace capture without source
inclusion. Playwright buffers API responses before this check; it is not a
streaming transport memory limit.

Untrusted PR plans are not authoritative. A trusted Host or trusted CLI provides
target URL, origin policy, and any manual-plan authority.
