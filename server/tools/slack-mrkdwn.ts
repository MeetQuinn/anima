import slackifyMarkdown from 'slackify-markdown';

export function slackMrkdwnForMarkdown(markdown: string): string {
  const mrkdwn = slackifyMarkdown(markdown);
  return mrkdwn.endsWith('\n') ? mrkdwn.slice(0, -1) : mrkdwn;
}
