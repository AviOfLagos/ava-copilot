import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { checkAssistantName, DEFAULT_ASSISTANT_NAME } from '@extension/storage';
import type { AssistantNameProblem } from '@extension/storage';
import { useWakeChoice } from '../hooks/useAssistant';

const PROBLEMS: Record<AssistantNameProblem, Parameters<typeof t>[0]> = {
  empty: 'onboard_name_error_empty',
  tooLong: 'onboard_name_error_tooLong',
  characters: 'onboard_name_error_characters',
};

/** The message for a name that cannot be saved, or '' when it can. */
export function nameError(draft: string): string {
  const check = checkAssistantName(draft);
  return check.ok ? '' : t(PROBLEMS[check.problem]);
}

/**
 * Says when the wake phrase cannot follow the name: the on-device model does not know a word of it,
 * or the model is not installed to check. Nothing when "Hey <name>" works.
 */
export function WakeNote({ name, className }: { name: string; className?: string }) {
  const check = checkAssistantName(name);
  const valid = check.ok ? check.name : DEFAULT_ASSISTANT_NAME;
  const choice = useWakeChoice(valid);
  if (!choice || choice.followsName) return null;
  return (
    <p className={cn('text-muted-foreground text-[11.5px]', className)} data-testid="wake-note">
      {t(choice.unchecked ? 'onboard_wake_unchecked' : 'onboard_wake_fallback', [valid])}
    </p>
  );
}

interface NameInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  className?: string;
  autoFocus?: boolean;
  errorId?: string;
}

/** The text box for the name: at most 24 characters, marked invalid while it cannot be saved. */
export function NameInput({ id, value, onChange, onBlur, className, autoFocus, errorId }: NameInputProps) {
  const invalid = nameError(value) !== '';
  return (
    <input
      id={id}
      type="text"
      value={value}
      maxLength={40}
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={autoFocus}
      autoComplete="off"
      spellCheck={false}
      aria-invalid={invalid}
      aria-describedby={invalid ? errorId : undefined}
      placeholder={DEFAULT_ASSISTANT_NAME}
      onChange={event => onChange(event.target.value)}
      onBlur={() => onBlur?.()}
      className={cn(
        'bg-card focus:border-primary/50 rounded-lg border text-foreground outline-none',
        invalid && 'border-destructive/60',
        className,
      )}
    />
  );
}
