// What a connected account may do with a release, and the exact wallet request for each action.
// Pure functions, no DOM and no network, so the rules are tested in Node.
//
// The contract enforces every rule again; this only decides which buttons to show and builds
// the transaction. A button that is shown for the wrong account fails on chain, it never
// succeeds wrongly.

const NEAR = 10n ** 24n;
const tgas = (n) => String(BigInt(n) * 10n ** 12n);
const near = (n) => String((BigInt(Math.round(n * 1000)) * NEAR) / 1000n);

export const FLAG_BOND_NEAR = 0.1;
export const HANDOFF_DEPOSIT_NEAR = 0.03;

const isMember = (summary, account) => Boolean(account) && summary.members.includes(account);

/**
 * The actions that make sense for a release in its current status.
 * Each has `can` (this account may do it now), `note` (why not, or what it does), and `needs`
 * (an input the user must give: 'reason' or 'artifactUrl').
 * `handoffReady` says whether the contract has OutLayer settings.
 */
export function availableActions({ summary, account, nowMs = Date.now(), handoffReady = true }) {
  if (!summary?.status) return [];
  const out = [];
  const member = isMember(summary, account);
  const memberNote = (done, doneText) => (!account ? 'Connect a wallet.' : !member ? 'Only project members can do this.' : done ? doneText : '');
  switch (summary.status) {
    case 'Proposed': {
      const done = summary.approvals.includes(account);
      out.push({
        id: 'approve', label: 'Approve this hash', method: 'approve_release',
        can: member && !done, note: memberNote(done, 'You already approved.') || 'Approves exactly this artifact hash.',
      });
      break;
    }
    case 'Pending': {
      const open = summary.readyAtMs != null && nowMs < summary.readyAtMs;
      if (open) {
        out.push({
          id: 'flag', label: 'Flag it', method: 'flag_release', needs: 'reason', depositNear: FLAG_BOND_NEAR,
          can: Boolean(account), note: account
            ? `Blocks the release until the members decide. Needs a ${FLAG_BOND_NEAR} NEAR bond (returned if they reject it).`
            : 'Connect a wallet.',
        });
      } else {
        out.push({
          id: 'execute', label: 'Start execution', method: 'execute_release',
          can: Boolean(account), note: account ? 'The public window has passed. Anyone may start execution.' : 'Connect a wallet.',
        });
      }
      break;
    }
    case 'Flagged': {
      const done = summary.dismissVotes.includes(account);
      out.push({
        id: 'dismiss', label: 'Dismiss the flag', method: 'dismiss_flag',
        can: member && !done, note: memberNote(done, 'You already voted.') || 'At the threshold the flagger loses the bond and a new window starts.',
      });
      break;
    }
    case 'Executing': {
      out.push({
        id: 'handoff', label: 'Hand to OutLayer', method: 'request_publish', needs: 'artifactUrl', depositNear: HANDOFF_DEPOSIT_NEAR,
        can: Boolean(account) && handoffReady,
        note: !handoffReady
          ? 'This contract has no OutLayer settings, so publishing goes through the CLI relay.'
          : account
            ? `The contract calls OutLayer, which runs the worker. ${HANDOFF_DEPOSIT_NEAR} NEAR is attached; OutLayer refunds what it does not use.`
            : 'Connect a wallet.',
      });
      break;
    }
    case 'Released': {
      const done = summary.recallVotes.includes(account);
      out.push({
        id: 'recall', label: 'Vote to recall', method: 'recall_release',
        can: member && !done, note: memberNote(done, 'You already voted.') || 'Members vote to mark a published release as recalled.',
      });
      break;
    }
    default:
      break;
  }
  if (['Proposed', 'Pending', 'Flagged'].includes(summary.status)) {
    const done = summary.rejectVotes.includes(account);
    out.push({
      id: 'reject', label: 'Vote to reject', method: 'reject_release',
      can: member && !done, note: memberNote(done, 'You already voted.') || 'At the threshold the release is rejected for good.',
    });
  }
  return out;
}

/** Why an input is not acceptable, or '' when it is. */
export function checkInput(action, value) {
  if (action.needs === 'reason') {
    const v = String(value || '').trim();
    if (!v) return 'Give a reason.';
    if (v.length > 500) return 'The reason is limited to 500 characters.';
  }
  if (action.needs === 'artifactUrl') {
    const v = String(value || '').trim();
    if (!/^https:\/\/\S+$/.test(v) || v.length > 2048) return 'Give the https URL the package file can be downloaded from.';
  }
  return '';
}

/** The request to hand to a NEAR wallet (near-connect "ConnectorAction" format). */
export function buildRequest({ contract, project, version, action, value }) {
  const err = checkInput(action, value);
  if (err) throw new Error(err);
  const args = { project_id: project, version };
  if (action.needs === 'reason') args.reason = String(value).trim();
  if (action.needs === 'artifactUrl') args.artifact_url = String(value).trim();
  return {
    receiverId: contract,
    actions: [
      {
        type: 'FunctionCall',
        params: {
          methodName: action.method,
          args,
          gas: tgas(action.id === 'handoff' ? 250 : 60),
          deposit: action.depositNear ? near(action.depositNear) : '0',
        },
      },
    ],
  };
}
