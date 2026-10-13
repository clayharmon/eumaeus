import type { CredentialSource } from './credentials.ts';
import { ghApi } from './github.ts';

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface MergeResult {
  merged: boolean;
  sha: string | null;
  message: string;
  branch: string;
  branch_deleted: boolean;
  url: string;
}

/** Merge a PR with the job identity (bot token for the repo), optionally deleting the head branch. */
export async function mergePr(
  creds: CredentialSource,
  repo: string,
  number: number,
  method: MergeMethod,
  deleteBranch: boolean,
): Promise<MergeResult> {
  const { token } = await creds.identityFor(repo);
  const pr = await ghApi<{ head: { ref: string }; html_url: string; mergeable: boolean | null; mergeable_state: string; state: string }>(
    `/repos/${repo}/pulls/${number}`, token);
  if (pr.state !== 'open') return { merged: false, sha: null, message: `PR is ${pr.state}`, branch: pr.head.ref, branch_deleted: false, url: pr.html_url };
  if (pr.mergeable === false) {
    return { merged: false, sha: null, message: `not mergeable (${pr.mergeable_state}); submit a job on branch ${pr.head.ref} to resolve it`, branch: pr.head.ref, branch_deleted: false, url: pr.html_url };
  }
  const r = await ghApi<{ merged: boolean; sha: string; message: string }>(`/repos/${repo}/pulls/${number}/merge`, token, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: method }),
  });
  let branchDeleted = false;
  if (r.merged && deleteBranch) {
    await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${encodeURIComponent(pr.head.ref)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'eumaeus' },
    }).then((res) => { branchDeleted = res.ok; });
  }
  return { merged: r.merged, sha: r.sha, message: r.message, branch: pr.head.ref, branch_deleted: branchDeleted, url: pr.html_url };
}
