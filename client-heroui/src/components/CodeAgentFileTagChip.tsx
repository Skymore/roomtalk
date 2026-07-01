import { inferEntryKindFromPath } from '../utils/codeAgentPierreIcons';
import { CodeAgentPierreEntryIcon } from './CodeAgentPierreEntryIcon';

export const CODE_AGENT_FILE_TAG_CHIP_CLASS_NAME =
  'inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-[#dedbd0] bg-[#f0eee6] px-2 py-1 text-xs font-semibold text-[#141413] dark:border-[#30302e] dark:bg-[#242421] dark:text-[#faf9f5]';

export const CODE_AGENT_CHAT_FILE_TAG_CHIP_CLASS_NAME =
  'inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-[#dedbd0] bg-[#faf9f5] px-2 py-1 text-xs font-semibold text-[#141413] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5]';

export function CodeAgentFileTagChipContent(props: {
  path: string;
  label: string;
  theme: 'light' | 'dark';
  selectable?: boolean;
}) {
  return (
    <>
      <CodeAgentPierreEntryIcon
        pathValue={props.path}
        kind={inferEntryKindFromPath(props.path)}
        theme={props.theme}
        className="h-3.5 w-3.5"
      />
      <span
        className={
          props.selectable
            ? 'min-w-0 truncate font-mono'
            : 'min-w-0 truncate'
        }
      >
        {props.label}
      </span>
    </>
  );
}
