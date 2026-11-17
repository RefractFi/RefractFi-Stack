// Product-facing copy; operating details and legal review must be completed before launch.
export const legalContent = {
  terms: {
    title: 'Terms of Service',
    lead: 'The rules and risks that apply when using RefractFi accounts, agent permissions, perpetual markets and liquidity services.',
    sections: [
      ['Using RefractFi', [
        'RefractFi is designed as an agent-native perpetuals system on Robinhood Chain. A Crystal is an owner-controlled margin account; Beams define the trading permissions and risk settings for individual agents.',
        'By using the service, you are responsible for complying with applicable laws, assessing your eligibility and understanding the transactions you authorize. Access to particular features, assets or markets may be restricted.'
      ]],
      ['Eligibility and restrictions', [
        'The product specification excludes persons in the United States, United Kingdom and Canada. Additional geographic, sanctions, age or other restrictions may apply. Do not use the service where doing so would violate applicable law or circumvent an access restriction.'
      ]],
      ['Wallets, accounts and agents', [
        'You are responsible for your wallet, private keys, account access, agent credentials and the settings you authorize. Do not share private keys or approve a transaction you do not understand. A connected wallet does not give the interface custody of its private keys.',
        'Beam permissions are intended to limit each agent to its authorized markets, budget, leverage and other rules. Agent trading authority is separate from owner withdrawal authority. Review permissions regularly and revoke access when an agent should no longer act.'
      ]],
      ['Execution, fees and liquidity', [
        'Eligible opposing orders may be crossed in a five-second window at the applicable close mark. Eligible residual flow may be routed to the Lens, subject to the protocol’s limits and available liquidity. Execution is not guaranteed.',
        'Trading, network and other applicable fees reduce results. Review the fees and transaction details shown before authorizing an action. Lens liquidity takes exposure to residual trading activity; liquidity providers can lose value and withdrawals may be limited by reserved collateral.'
      ]],
      ['Risk of loss', [
        'Perpetual contracts and leveraged positions can move rapidly against you and can result in substantial loss or liquidation. Smart-contract, network, oracle, agent, market, liquidity and operational failures can cause additional loss.',
        'Risk limits, stop thresholds and automated controls are not guarantees. Enforcement may lag during fast markets or outages, and closing one position can increase the remaining net exposure. Nothing in the service is financial, investment, tax or legal advice.'
      ]],
      ['Third-party services and changes', [
        'Wallets, blockchain networks, price data and other third-party services operate under their own terms and may fail or change. Names of networks or providers do not imply endorsement or affiliation.',
        'Features, parameters and these terms may change. Review the applicable information before using a feature or authorizing a transaction.'
      ]]
    ]
  },
  privacy: {
    title: 'Privacy Policy',
    lead: 'How information may be handled when you use RefractFi accounts, agent tools, markets and liquidity services.',
    sections: [
      ['Scope', [
        'This policy describes information associated with the RefractFi interface and related account, trading, agent and liquidity services. Third-party wallets, blockchain networks and other independent providers have their own privacy practices.'
      ]],
      ['Information associated with your use', [
        'Depending on the features used, information may include a public wallet address, transaction and position details, Crystal and Beam settings, agent activity and decision traces, and communications you choose to provide.',
        'Technical information such as device, browser, network and security logs may be processed where needed to operate, protect and troubleshoot a service. Some settings can also be stored on your device.'
      ]],
      ['Public blockchain records', [
        'Blockchain transactions and associated wallet addresses can be public, persistent and linkable. On-chain records are maintained by the network and generally cannot be edited or erased by RefractFi. Avoid placing personal or confidential information in public transaction data.'
      ]],
      ['How information may be used', [
        'Information may be used to provide requested functions, display account and transaction activity, enforce risk controls, support operations, investigate abuse and meet applicable legal obligations. Access to information should be limited to what is needed for those purposes.'
      ]],
      ['Service providers and security', [
        'Services used to provide infrastructure, analytics, security, support or other functions may process information as needed for those purposes. Information may also be disclosed where required by law or necessary to protect rights and safety.',
        'Security measures reduce risk but cannot guarantee complete security. Protect wallet keys and agent credentials; do not submit private keys to the interface.'
      ]],
      ['Retention and your choices', [
        'Off-chain information should be retained only as long as needed for its purpose, security, dispute resolution or applicable legal obligations. Retention depends on the type of information and the service involved; public blockchain records are outside this retention control.',
        'Depending on applicable law, you may have rights to request access, correction, deletion, restriction, portability or objection. Those rights can be limited, including for immutable public blockchain records. Requests should be made through the official support channel made available for the service.'
      ]]
    ]
  }
};
