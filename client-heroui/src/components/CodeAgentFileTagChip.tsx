import { inferEntryKindFromPath } from '../utils/codeAgentPierreIcons';
import {
  CODE_AGENT_CHAT_INLINE_CHIP_CLASS_NAME,
  CODE_AGENT_CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  CODE_AGENT_COMPOSER_INLINE_CHIP_CLASS_NAME,
  CODE_AGENT_COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  CODE_AGENT_COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from './codeAgentComposerInlineChip';
import { CodeAgentPierreEntryIcon } from './CodeAgentPierreEntryIcon';

export const CODE_AGENT_FILE_TAG_CHIP_CLASS_NAME = CODE_AGENT_COMPOSER_INLINE_CHIP_CLASS_NAME;

export const CODE_AGENT_CHAT_FILE_TAG_CHIP_CLASS_NAME = CODE_AGENT_CHAT_INLINE_CHIP_CLASS_NAME;

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
        className={CODE_AGENT_COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
      />
      <span
        className={
          props.selectable
            ? CODE_AGENT_CHAT_INLINE_CHIP_LABEL_CLASS_NAME
            : CODE_AGENT_COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME
        }
      >
        {props.label}
      </span>
    </>
  );
}
