# Test fixtures

## `led-par-64-rgbw.description.xml`

The `description.xml` from `BlenderDMX@LED_PAR_64_RGBW@v0.3.gdtf`, taken
verbatim from the test files of [python-gdtf][], which is MIT licensed:

> MIT License
>
> Copyright (c) 2023 Open Stage
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

It is here because `gdtf.test.ts` otherwise builds its own XML, and a parser
checked only against documents written by the same person who wrote the parser
proves that the two agree — not that either is right. This one was written by
a different tool, and it is where the "real profile" tests point.

The 3D models and thumbnail from the original archive are not included; only
the XML is read.

[python-gdtf]: https://github.com/open-stage/python-gdtf
