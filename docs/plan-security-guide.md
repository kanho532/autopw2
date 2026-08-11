# Plan Security Guide

Plans are data, never executable code. The validator rejects arbitrary JavaScript,
shell/import fields, unsafe URLs, unsupported actions, and automatic CSS/XPath.
The runner enforces allowed origins, production mutation policy, response-body
limits, case isolation, cleanup, evidence redaction, and trace capture without
source inclusion.

Untrusted PR plans are not authoritative. A trusted Host or trusted CLI provides
target URL, origin policy, and any manual-plan authority.
