/** Product mark: the shop's initials on the cloud edition, the Prompt OS icon and wordmark on-prem. */
import { IS_CLOUD } from '../cloud';
import icon from '../assets/promptos-icon.png';
import wordmark from '../assets/promptos-light.png';

export function BrandMark({ initials }: { initials: string }) {
  return IS_CLOUD ? <div className="logo">{initials}</div> : <img className="logo logo-img" src={icon} alt="Prompt OS" />;
}

/** Full product name for the sign-in, first-run and restore cards. */
export function BrandName({ cloudName }: { cloudName: string }) {
  return IS_CLOUD ? <b>{cloudName}</b> : <img src={wordmark} alt="Prompt OS" style={{ height: 30, width: 'auto', display: 'block' }} />;
}
