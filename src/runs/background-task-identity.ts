export async function backgroundTaskArn(metadataUri: string | undefined): Promise<string | null> {
  if (!metadataUri) return null;
  const response = await fetch(`${metadataUri.replace(/\/$/, "")}/task`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Task metadata returned ${response.status}`);
  const data = (await response.json()) as { TaskARN?: unknown };
  if (typeof data.TaskARN !== "string" || !data.TaskARN.startsWith("arn:") || !data.TaskARN.includes(":task/"))
    throw new Error("Task metadata did not contain a task ARN");
  return data.TaskARN;
}
