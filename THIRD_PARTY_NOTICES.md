# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## LimitlessLED developer page

The UDP protocol (session request and answer, framing, checksum,
acknowledgement, order codes of each kind of lamp, legacy codes) was written
from the developer documentation published by LimitlessLED
(limitlessled.com/dev). No code was taken from it.

## node-milight-promise

- Source: https://github.com/mwittig/node-milight-promise (version 0.3.2,
  2019-01-15)
- Licence: MIT
- What was used: the shift of the colour wheel of the v6 bulbs relative to
  the legacy wheel (0x37 for RGBW, 0x48 for RGB+CCT, 0x52 for the bridge
  lamp), and, as a cross-check of the developer page, the v6 order codes
  and the session id position in the session answer. The code of this
  integration (sender, sessions, acknowledgements, colour conversion) is its
  own.

```
The MIT License (MIT)

Copyright (c) 2015 Marcus Wittig

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
```
