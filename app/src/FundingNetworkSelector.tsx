import { Link } from "react-router-dom";
import { fundingNetworkDestination, type FundingNetwork } from "./fundingNetwork";
import "./fundingNetwork.css";

export function FundingNetworkSelector({ selected, mainnetAvailable, home = false, locked = false }: {
  selected: FundingNetwork;
  mainnetAvailable: boolean;
  home?: boolean;
  locked?: boolean;
}) {
  if (!mainnetAvailable) return null;
  return <div className="fundingNetworkPicker">
    <nav aria-label="Choose funding network" className="fundingNetworkOptions">
      {(["mainnet", "testnet"] as const).map(network => {
        const content = <strong>{network === "mainnet" ? "Mainnet" : "Testnet"}</strong>;
        return locked ? <button key={network} type="button" disabled className={selected === network ? "selected" : undefined}>{content}</button> :
          <Link key={network} to={fundingNetworkDestination(network, home)} aria-current={selected === network ? "true" : undefined} className={selected === network ? "selected" : undefined}>{content}</Link>;
      })}
    </nav>
    <p>{locked ? "Wait for the current check or review to finish, and resolve any pending payment before changing networks." : "Each network has separate balances and funding lines. Switching does not move USDC or approve a wallet action."}</p>
  </div>;
}
