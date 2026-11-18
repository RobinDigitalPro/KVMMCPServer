# vmulti protocol

The vmulti backend uses the report layouts and identifiers defined by
[djpnewton/vmulti](https://github.com/djpnewton/vmulti), commit
`c790d58deedb8a9cc0fcd57ec59cb7c0ef6324ff`.
The JavaScript encoder and C# transport are new implementations.

The MIT License (MIT)

Copyright (c) 2016 djpnewton

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# MCP SDK and schema validation

The local MCP adapter imports the official MCP TypeScript SDK packages
`@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4.0,
published under Apache-2.0. The client is a development/test dependency.
Upstream: https://github.com/modelcontextprotocol/typescript-sdk

Zod 4.6.7 is used for tool schemas and validation, under MIT.
Upstream: https://github.com/colinhacks/zod

Exact dependency versions and integrity hashes are recorded in pnpm-lock.yaml.
Dependency license files accompany the installed packages; preserve them when
redistributing those packages. The project's own source remains MIT licensed.
