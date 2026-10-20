import { test } from "node:test";
import assert from "node:assert/strict";
import { awsErrorCode, awsUsageError } from "../src/aws-lease.ts";
import { guardLambdaMicrovms } from "../src/backends/aws.ts";
import { capture } from "../src/util.ts";

function failure(script: string): unknown {
  try {
    capture(process.execPath, ["-e", script]);
  } catch (error) {
    return error;
  }
  return assert.fail("the command should have failed");
}

test("awsErrorCode reads the error code from the AWS CLI's JSON error output, past any warnings", () => {
  const error = failure(
    `console.error("urllib3 InsecureRequestWarning"); console.error(JSON.stringify({ Code: "ResourceNotFoundException", Message: "no such secret" }, null, 4)); process.exit(254);`,
  );
  assert.equal(awsErrorCode(error), "ResourceNotFoundException");
});

test("a command line the AWS CLI rejects is a usage error, reported with the CLI's own output", () => {
  const error = failure(
    `console.error("aws: [ERROR]: argument command: Found invalid choice 'lambda-microvms'"); process.exit(252);`,
  );
  assert.equal(awsUsageError(error), true);
  assert.equal(awsErrorCode(error), undefined);
  assert.throws(
    () => guardLambdaMicrovms(error),
    /qm needs AWS CLI v2\.35\.10 or newer.*invalid choice 'lambda-microvms'/s,
  );
});

test("an AWS service error that is not a usage error passes through unchanged", () => {
  const other = failure(`console.error(JSON.stringify({ Code: "ThrottlingException" })); process.exit(254);`);
  assert.equal(awsUsageError(other), false);
  assert.throws(
    () => guardLambdaMicrovms(other),
    (error: unknown) => error === other,
  );
});
