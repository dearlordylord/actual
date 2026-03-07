import { exec } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { exit } from 'node:process';

import prompts from 'prompts';

async function run() {
  const hasGhCli = await checkGhCli();
  const username = hasGhCli ? await execAsync("gh api user --jq '.login'") : '';

  if (!username) {
    console.log(
      'Tip: Install the GitHub CLI (https://github.com/cli/cli) and run `gh auth login` to enable auto-detection of your username and auto-creation of draft PRs.',
    );
  }

  const activePr = await getActivePr(username);
  if (activePr) {
    console.log(`Found existing PR #${activePr.number}: ${activePr.title}`);
  }

  // Ask for category and summary first (before PR number)
  const initial = await prompts([
    {
      name: 'githubUsername',
      message: 'Comma-separated GitHub username(s)',
      type: 'text',
      initial: username,
    },
    {
      name: 'releaseNoteType',
      message: 'Release Note Type',
      type: 'select',
      choices: [
        { title: '✨ Features', value: 'Features' },
        { title: '👍 Enhancements', value: 'Enhancements' },
        { title: '🐛 Bugfixes', value: 'Bugfixes' },
        { title: '⚙️  Maintenance', value: 'Maintenance' },
      ],
    },
    {
      name: 'oneLineSummary',
      message: 'Brief Summary',
      type: 'text',
      initial: activePr?.title,
    },
  ]);

  if (
    !initial.githubUsername ||
    !initial.oneLineSummary ||
    initial.releaseNoteType === undefined
  ) {
    console.log('All questions must be answered. Exiting');
    exit(1);
  }

  // Determine PR number: use existing PR, offer to create draft, or ask manually
  let prNumber: number;

  if (activePr) {
    prNumber = activePr.number;
  } else if (hasGhCli) {
    const { action } = await prompts({
      name: 'action',
      message: 'No existing PR found. How would you like to get the PR number?',
      type: 'select',
      choices: [
        {
          title: '🚀 Create a draft PR automatically',
          value: 'create-draft',
          description:
            'Creates a draft PR using the GitHub CLI and uses its number',
        },
        {
          title: '✏️  Enter PR number manually',
          value: 'manual',
          description: 'Enter a PR number you already know',
        },
      ],
    });

    if (!action) {
      console.log('Exiting');
      exit(1);
    }

    if (action === 'create-draft') {
      prNumber = await createDraftPr(initial.oneLineSummary);
    } else {
      prNumber = await askForPrNumber();
    }
  } else {
    prNumber = await askForPrNumber();
  }

  const fileContents = getFileContents(
    initial.releaseNoteType,
    initial.githubUsername,
    initial.oneLineSummary,
  );

  const filepath = `./upcoming-release-notes/${prNumber}.md`;
  if (existsSync(filepath)) {
    const { confirm } = await prompts({
      name: 'confirm',
      type: 'confirm',
      message: `This will overwrite the existing release note ${filepath}. Are you sure?`,
    });
    if (!confirm) {
      console.log('Exiting');
      exit(1);
    }
  }

  writeFileSync(filepath, fileContents);
  console.log(`Release note generated successfully: ${filepath}`);
}

async function checkGhCli(): Promise<boolean> {
  const result = await execAsync('gh --version');
  return result !== '';
}

async function createDraftPr(title: string): Promise<number> {
  // Ensure current branch is pushed to remote
  const branchName = await execAsync('git rev-parse --abbrev-ref HEAD');
  if (!branchName || branchName === 'master' || branchName === 'main') {
    console.error(
      'Cannot create a draft PR from the main/master branch. Please switch to a feature branch first.',
    );
    exit(1);
  }

  console.log(`Pushing branch "${branchName}" to remote...`);
  const pushResult = await execAsync(
    `git push -u origin ${branchName} 2>&1`,
    'Failed to push branch to remote. Please push manually first.',
  );
  if (pushResult === '') {
    // execAsync returns '' on error
    exit(1);
  }

  console.log('Creating draft PR...');
  const prUrl = await execAsync(
    `gh pr create --draft --title "${title.replace(/"/g, '\\"')}" --body "" 2>&1`,
    'Failed to create draft PR. Please create one manually via GitHub.',
  );

  if (!prUrl) {
    exit(1);
  }

  // Extract PR number from URL (e.g., https://github.com/owner/repo/pull/1234)
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  if (!prNumberMatch) {
    // gh pr create might return just a number or other format
    const numberMatch = prUrl.match(/(\d+)/);
    if (!numberMatch) {
      console.error('Could not parse PR number from output:', prUrl);
      exit(1);
    }
    const prNumber = parseInt(numberMatch[1], 10);
    console.log(`Draft PR #${prNumber} created: ${prUrl.trim()}`);
    return prNumber;
  }

  const prNumber = parseInt(prNumberMatch[1], 10);
  console.log(`Draft PR #${prNumber} created: ${prUrl.trim()}`);
  return prNumber;
}

async function askForPrNumber(): Promise<number> {
  const nextPrNumber = await getNextPrNumber();
  const { pullRequestNumber } = await prompts({
    name: 'pullRequestNumber',
    message: 'PR Number',
    type: 'number',
    initial: nextPrNumber,
  });

  if (!pullRequestNumber) {
    console.log('PR number is required. Exiting');
    exit(1);
  }

  return pullRequestNumber;
}

// makes an attempt to find an existing open PR from <username>:<branch>
async function getActivePr(
  username: string,
): Promise<{ number: number; title: string } | undefined> {
  if (!username) {
    return undefined;
  }
  const branchName = await execAsync('git rev-parse --abbrev-ref HEAD');
  if (!branchName) {
    return undefined;
  }
  const forkHead = `${username}:${branchName}`;
  return getPrNumberFromHead(forkHead);
}

async function getPrNumberFromHead(
  head: string,
): Promise<{ number: number; title: string } | undefined> {
  try {
    // head is a weird query parameter in this API call. If nothing matches, it
    // will return as if the head query parameter doesn't exist. To get around
    // this, we make the page size 2 and only return the number if the length.
    const resp = await fetch(
      'https://api.github.com/repos/actualbudget/actual/pulls?state=open&per_page=2&head=' +
        head,
    );
    if (!resp.ok) {
      console.warn('error fetching from github pulls api:', resp.status);
      return undefined;
    }
    const ghResponse = await resp.json();
    if (ghResponse?.length === 1) {
      return ghResponse[0];
    } else {
      return undefined;
    }
  } catch (e) {
    console.warn('error fetching from github pulls api:', e);
  }
}

async function getNextPrNumber(): Promise<number> {
  try {
    const resp = await fetch(
      'https://api.github.com/repos/actualbudget/actual/issues?state=all&per_page=1',
    );
    if (!resp.ok) {
      throw new Error(`API responded with status: ${resp.status}`);
    }
    const ghResponse = await resp.json();
    const latestPrNumber = ghResponse?.[0]?.number;
    if (!latestPrNumber) {
      console.error(
        'Could not find latest issue number in GitHub API response',
        ghResponse,
      );
      exit(1);
    }
    return latestPrNumber + 1;
  } catch (error) {
    console.error('Failed to fetch next PR number:', error);
    exit(1);
  }
}

function getFileContents(type: string, username: string, summary: string) {
  return `---
category: ${type}
authors: [${username}]
---

${summary}
`;
}

// simple exec that fails silently and returns an empty string on failure
async function execAsync(cmd: string, errorLog?: string): Promise<string> {
  return new Promise<string>(res => {
    exec(cmd, (error, stdout) => {
      if (error) {
        if (errorLog) {
          console.log(errorLog);
        }
        res('');
      } else {
        res(stdout.trim());
      }
    });
  });
}

void run();
