import { Link, useLocation } from 'react-router-dom';
import { CandidateFundingDesk } from './CandidateFundingDesk';
import { PUBLIC_MAINNET, PUBLIC_MAINNET_SERVICE } from './publicMainnet';
import { LEGACY_PUBLIC_MAINNET, LEGACY_PUBLIC_MAINNET_SERVICE } from './legacyPublicMainnet';
import { mainnetRelease } from './mainnetRelease';

export function MainnetFundingPage() {
  const { search, pathname } = useLocation();
  const release = mainnetRelease(search);
  if (!release) return <section aria-label="Unknown mainnet release" className="routePage fundingDesk">
    <h1>This funding link names an unknown release.</h1>
    <p>No wallet action was requested. Ask the sponsor for the original link.</p>
    <Link to="/mainnet">Open mainnet</Link>
  </section>;
  const legacy = release === 'legacy';
  return <CandidateFundingDesk key={`${release}:${pathname}`} mainnetRelease={release} purchaseOnly={pathname === '/mainnet/purchase'}
    deployment={legacy ? LEGACY_PUBLIC_MAINNET : PUBLIC_MAINNET}
    service={legacy ? LEGACY_PUBLIC_MAINNET_SERVICE : PUBLIC_MAINNET_SERVICE} />;
}
