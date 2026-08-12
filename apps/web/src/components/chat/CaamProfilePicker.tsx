import { memo } from "react";
import { CircleUserRoundIcon } from "lucide-react";

import { CAAM_DEFAULT_PROFILE_VALUE } from "../../caamProfiles";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";

/**
 * Composer footer control for choosing the caam account profile a coding
 * session runs under. Visually mirrors `ComposerFooterModeControls`' runtime
 * `Select`. The `null` value (the "Default account" entry) means "no explicit
 * selection" — the server then applies its per-project default. The sentinel
 * value {@link CAAM_DEFAULT_PROFILE_VALUE} stands in for `null` inside the
 * `Select` primitive and is mapped back at the boundary.
 */
export const CaamProfilePicker = memo(function CaamProfilePicker(props: {
  profiles: readonly string[];
  value: string | null;
  projectDefaultProfile?: string | undefined;
  disabled?: boolean | undefined;
  onChange: (value: string | null) => void;
}) {
  const selectValue = props.value ?? CAAM_DEFAULT_PROFILE_VALUE;
  const activeLabel = props.value ?? "Default account";
  const defaultSubtitle = props.projectDefaultProfile
    ? `Project default: ${props.projectDefaultProfile}`
    : "No explicit account — use the project default";

  return (
    <Tooltip>
      <Select
        value={selectValue}
        onValueChange={(value) => {
          props.onChange(value === CAAM_DEFAULT_PROFILE_VALUE ? null : value!);
        }}
        {...(props.disabled ? { disabled: true } : {})}
      >
        <TooltipTrigger
          render={<ComposerSelectControl className="font-medium" aria-label="caam account" />}
        >
          <ComposerControlIcon icon={CircleUserRoundIcon} />
          <SelectValue>{activeLabel}</SelectValue>
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value={CAAM_DEFAULT_PROFILE_VALUE} hideIndicator className="min-w-64 py-2">
            <div className="grid min-w-0 gap-0.5">
              <span className="font-medium text-foreground">Default account</span>
              <span className="text-muted-foreground text-xs leading-4">{defaultSubtitle}</span>
            </div>
          </SelectItem>
          {props.profiles.map((profile) => (
            <SelectItem key={profile} value={profile} hideIndicator className="min-w-64 py-2">
              <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                <CircleUserRoundIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{profile}</span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">Account profile for this session</TooltipPopup>
    </Tooltip>
  );
});
