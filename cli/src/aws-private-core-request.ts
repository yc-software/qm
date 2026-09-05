export const AWS_PRIVATE_CORE_REQUEST_BODY_MAX_BYTES = 1_000_000;
export const AWS_PRIVATE_CORE_RESPONSE_MAX_BYTES = 1_100_000;
export const AWS_PRIVATE_CORE_OBJECT_MAX_BYTES = 2_300_000;
export const AWS_PRIVATE_CORE_OVERRIDES_MAX_BYTES = 8_192;

const FAILURE_CODES = new Set<AwsPrivateCoreFailureCode>([
  "input_unavailable",
  "invalid_input",
  "missing_signing_secret",
  "core_unavailable",
  "core_response_too_large",
]);

export type AwsPrivateCoreFailureCode =
  "input_unavailable" | "invalid_input" | "missing_signing_secret" | "core_unavailable" | "core_response_too_large";

export type AwsPrivateCoreResponse =
  { version: 1; ok: true; status: number; body: string } | { version: 1; ok: false; code: AwsPrivateCoreFailureCode };

export interface AwsPrivateSecretValidation {
  command: string[];
  environment: Array<{ name: string; value: string }>;
  invalidSecret: (exitCode: number | undefined) => string | undefined;
}

export function awsPrivateCoreKeys(requestId: string): { request: string; response: string } {
  const prefix = `deployment/core-requests/${requestId}`;
  return { request: `${prefix}/request.json`, response: `${prefix}/response.json` };
}

export function awsPrivateCoreRequestBody(method: "GET" | "PUT", body: string): string {
  if (Buffer.byteLength(body) > AWS_PRIVATE_CORE_REQUEST_BODY_MAX_BYTES || (method === "GET" && body !== "")) {
    throw new Error("AWS private core request body is invalid");
  }
  const encoded = JSON.stringify({ version: 1, method, body });
  if (Buffer.byteLength(encoded) > AWS_PRIVATE_CORE_OBJECT_MAX_BYTES) {
    throw new Error("AWS private core request object is too large");
  }
  return encoded;
}

export function parseAwsPrivateCoreResponse(body: string): AwsPrivateCoreResponse {
  if (Buffer.byteLength(body) > AWS_PRIVATE_CORE_OBJECT_MAX_BYTES) {
    throw new Error("AWS private core response object is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new Error("AWS private core response object is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AWS private core response object is invalid");
  }
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result).sort().join("\0");
  if (result.version !== 1 || typeof result.ok !== "boolean") {
    throw new Error("AWS private core response object is invalid");
  }
  if (result.ok) {
    if (
      keys !== ["body", "ok", "status", "version"].sort().join("\0") ||
      !Number.isInteger(result.status) ||
      (result.status as number) < 200 ||
      (result.status as number) > 599 ||
      typeof result.body !== "string" ||
      Buffer.byteLength(result.body) > AWS_PRIVATE_CORE_RESPONSE_MAX_BYTES ||
      (((result.status as number) < 200 || (result.status as number) >= 300) && result.body !== "")
    ) {
      throw new Error("AWS private core response object is invalid");
    }
    return { version: 1, ok: true, status: result.status as number, body: result.body };
  }
  if (
    keys !== ["code", "ok", "version"].sort().join("\0") ||
    typeof result.code !== "string" ||
    !FAILURE_CODES.has(result.code as AwsPrivateCoreFailureCode)
  ) {
    throw new Error("AWS private core response object is invalid");
  }
  return { version: 1, ok: false, code: result.code as AwsPrivateCoreFailureCode };
}

export function awsPrivateSecretValidation(names: string[], expectedPublicApiUrl: string): AwsPrivateSecretValidation {
  if (
    names.length === 0 ||
    names.length > 245 ||
    names.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name)) ||
    names.some((name, index) => names.indexOf(name) !== index)
  ) {
    throw new Error("AWS private secret validation specification is invalid");
  }
  const expected = new URL(expectedPublicApiUrl);
  if (expected.protocol !== "https:") throw new Error("AWS private secret validation URL must use HTTPS");
  const ordered = [...names].sort();
  const script = `command -v printenv >/dev/null && command -v sed >/dev/null && command -v tr >/dev/null && command -v awk >/dev/null || exit 2
i=10
while IFS= read -r name; do
  value="$(printenv "$name" 2>/dev/null || true)"
  trimmed="$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  lower="$(printf '%s' "$trimmed" | tr '[:upper:]' '[:lower:]')"
  invalid=0
  case "$lower" in ''|replace-me|placeholder|changeme|todo) invalid=1;; esac
  case "$name" in
    CONNECTOR_SECRET_KEY|CORE_SIGNING_SECRET|SKILL_SIGNING_SECRET) [ "\${#trimmed}" -ge 32 ] || invalid=1;;
    ADMIN_GRANTS) printf '%s\n' "$trimmed" | awk -F, '{if(NF<1)exit 1;for(i=1;i<=NF;i++){e=$i;gsub(/^[ \t]+|[ \t]+$/, "", e);if(!match(e,/:[^:]*$/))exit 1;p=substr(e,1,RSTART-1);r=substr(e,RSTART+1);gsub(/^[ \t]+|[ \t]+$/, "", p);gsub(/^[ \t]+|[ \t]+$/, "", r);if(p==""||r!="org_admin")exit 1}}' || invalid=1;;
    PUBLIC_API_URL) [ "\${trimmed%/}" = "$QM_EXPECTED_PUBLIC_API_URL" ] || invalid=1;;
  esac
  [ "$invalid" -eq 0 ] || exit "$i"
  i=$((i+1))
done <<EOF
$QM_SECRET_VALIDATION_NAMES
EOF
exit 0`;
  return {
    command: ["sh", "-c", script],
    environment: [
      { name: "QM_EXPECTED_PUBLIC_API_URL", value: expected.toString().replace(/\/$/, "") },
      { name: "QM_SECRET_VALIDATION_NAMES", value: ordered.join("\n") },
    ],
    invalidSecret: (exitCode) =>
      exitCode !== undefined && exitCode >= 10 && exitCode < 10 + ordered.length ? ordered[exitCode - 10] : undefined,
  };
}

export function awsPrivateCoreTaskScript(): string {
  return `(async()=>{const{createHmac}=require("node:crypto"),{S3Client,GetObjectCommand,PutObjectCommand,DeleteObjectCommand}=require("@aws-sdk/client-s3");
const maxRequest=${AWS_PRIVATE_CORE_REQUEST_BODY_MAX_BYTES},maxResponse=${AWS_PRIVATE_CORE_RESPONSE_MAX_BYTES},maxObject=${AWS_PRIVATE_CORE_OBJECT_MAX_BYTES},id=process.env.QM_AWS_CORE_REQUEST_ID||"",bucket=process.env.QM_AWS_CORE_REQUEST_BUCKET||"",core=process.env.QM_AWS_CORE_REQUEST_URL||"",secret=process.env.CORE_SIGNING_SECRET||"",prefix="deployment/core-requests/"+id,inputKey=prefix+"/request.json",outputKey=prefix+"/response.json",s3=new S3Client(process.env.S3_REGION?{region:process.env.S3_REGION}:{});
class F extends Error{constructor(code){super(code);this.code=code}}
const exact=(o,n)=>Object.keys(o).sort().join("\\0")===n.sort().join("\\0"),bounded=async r=>{const declared=Number(r.headers.get("content-length"));if(Number.isFinite(declared)&&declared>maxResponse)throw new F("core_response_too_large");if(!r.body)return"";const reader=r.body.getReader(),chunks=[];let size=0;for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxResponse){await reader.cancel().catch(()=>{});throw new F("core_response_too_large")}chunks.push(Buffer.from(value))}return Buffer.concat(chunks).toString("utf8")};
const fail=e=>({version:1,ok:false,code:e instanceof F?e.code:"core_unavailable"});
let result;
try{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)||!bucket)throw new F("invalid_input");let origin;try{origin=new URL(core)}catch{throw new F("invalid_input")}if(origin.protocol!=="http:"||!origin.hostname||origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash)throw new F("invalid_input");let got;try{got=await s3.send(new GetObjectCommand({Bucket:bucket,Key:inputKey}))}catch{throw new F("input_unavailable")}if(!got.Body||!Number.isInteger(got.ContentLength)||got.ContentLength<1||got.ContentLength>maxObject)throw new F("input_unavailable");let bytes;try{bytes=Buffer.from(await got.Body.transformToByteArray())}catch{throw new F("input_unavailable")}if(bytes.length!==got.ContentLength)throw new F("input_unavailable");let request;try{request=JSON.parse(bytes.toString("utf8"))}catch{throw new F("invalid_input")}if(!request||typeof request!=="object"||!exact(request,["version","method","body"])||request.version!==1||(request.method!=="GET"&&request.method!=="PUT")||typeof request.body!=="string"||Buffer.byteLength(request.body)>maxRequest||(request.method==="GET"&&request.body!==""))throw new F("invalid_input");if(!secret)throw new F("missing_signing_secret");const path="/v1/deployment-layer",timestamp=Math.floor(Date.now()/1000),canonical=request.method+"\\n"+path+"\\n"+request.body,signature="v0="+createHmac("sha256",secret).update("v0:"+timestamp+":"+canonical).digest("hex");let response;try{response=await fetch(origin.toString().replace(/\\/$/,"")+path,{method:request.method,headers:{"content-type":"application/json","x-timestamp":String(timestamp),"x-signature":signature},...(request.method==="PUT"?{body:request.body}:{}),redirect:"manual",signal:AbortSignal.timeout(60000)})}catch{throw new F("core_unavailable")}if(!response.ok){await response.body?.cancel().catch(()=>{});result={version:1,ok:true,status:response.status,body:""}}else result={version:1,ok:true,status:response.status,body:await bounded(response)}}catch(error){result=fail(error)}
let published=false;try{await s3.send(new PutObjectCommand({Bucket:bucket,Key:outputKey,Body:JSON.stringify(result),ContentType:"application/json",CacheControl:"no-store"}));published=true}catch{console.error("AWS private core request could not publish its result")}finally{await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:inputKey})).catch(()=>{})}if(!published||!result.ok)process.exitCode=1})().catch(()=>{console.error("AWS private core request failed unexpectedly");process.exitCode=1});`;
}
