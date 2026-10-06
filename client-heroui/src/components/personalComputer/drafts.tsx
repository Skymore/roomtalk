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
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useState,
} from "react";

interface ComputerDrafts {
  tab: "Browser" | "Terminal" | "Files" | "Desktop";
  command: string;
  cwd: string;
  path: string;
  editor: { path: string; text: string; saved: string; savedPath: string } | undefined;
}
const DraftContext = createContext<{
  drafts: ComputerDrafts;
  setDrafts: Dispatch<SetStateAction<ComputerDrafts>>;
} | null>(null);

/** Keep unsent work when another sheet replaces the computer; never persist it to disk. */
export function ComputerDraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<ComputerDrafts>({
    tab: "Browser",
    command: "",
    cwd: "/workspace",
    path: "/workspace",
    editor: undefined,
  });
  return <DraftContext.Provider value={{ drafts, setDrafts }}>{children}</DraftContext.Provider>;
}
export function useComputerDraft<K extends keyof ComputerDrafts>(key: K) {
  const context = useContext(DraftContext);
  if (!context) throw new Error("Computer drafts are unavailable");
  const { setDrafts } = context;
  const set = useCallback(
    (value: SetStateAction<ComputerDrafts[K]>) => {
      setDrafts((current) => ({
        ...current,
        [key]: typeof value === "function" ? value(current[key]) : value,
      }));
    },
    [key, setDrafts],
  );
  return [context.drafts[key], set] as const;
}
