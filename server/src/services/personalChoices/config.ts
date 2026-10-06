export const defaultJevModel = 'jev-1.13.0';
export interface Config {jevMode: 'off'|'sample'|'live'; typesafeApiKey?:string; jevModel?:string}
export function personalChoicesConfig(): Config {
  const jevMode = process.env.JEV_MODE ?? 'off';
  if (jevMode !== 'off' && jevMode !== 'sample' && jevMode !== 'live') throw new Error('JEV_MODE must be off, sample or live');
  const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (jevMode === 'live' && !typesafeApiKey) throw new Error('JEV_MODE=live requires a nonblank TYPESAFE_API_KEY');
  return {jevMode, typesafeApiKey, jevModel:process.env.JEV_MODEL?.trim() || defaultJevModel};
}

/*
MIT License

Copyright (c) 2026 OpenMuse contributors

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

Ported from CopilotKit/OpenMuse 73a714963b57e5cd1747fd3fbc6833e09a36b81a.
*/
