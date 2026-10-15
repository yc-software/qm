# Freestyle agent computers

Freestyle is QM's most powerful sandbox option for long-running agent work. A
scope gets a full Ubuntu VM with a persistent disk, background processes, and
the ability to resume after a pause. QM addresses each VM by a stable slug,
so a core restart reconnects to the same computer.

Set `sandbox.backend` to `"freestyle"` in `qm.config.jsonc`. This works when
QM's core is hosted on Docker, Fly, or AWS. Supply `FREESTYLE_API_KEY` as a
core secret. The default image is `freestyle/ubuntu`; set
`env.core.FREESTYLE_SNAPSHOT_ID` to a snapshot ID or slug if you need a
preconfigured image. A custom image should provide an `ubuntu` user with UID
1000, passwordless `sudo`, a `/home/ubuntu` directory, `sh`, `tar`, and `base64`.
If it does not include AWS CLI v2 at `/usr/local/aws-cli/v2/current/bin/aws`,
it also needs `curl`, `sha256sum`, `unzip`, and `flock` for QM's pinned installer.

```jsonc
{
  "sandbox": { "backend": "freestyle" },
  "env": { "core": { "FREESTYLE_SNAPSHOT_ID": "freestyle/ubuntu" } },
}
```

The default VM firewall allows outbound public traffic and no inbound public
traffic. QM does not claim egress enforcement for this backend. Scope VMs are
kept running between turns so unattended processes can continue; Freestyle VM
usage is billed until you pause or retire them. Retiring a sandbox deletes its
VM and resident files. Scratch VMs are deleted when released and have a 24-hour
lifetime as a cleanup backstop.

`FREESTYLE_NAME_PREFIX` optionally changes the VM slug prefix. QM normalizes it
to lowercase hyphen-separated characters. The default is
`qm-<orgId>`. Use a distinct prefix for each deployment in one Freestyle account.
QM uses the Freestyle SDK for VM creation, command execution, and byte-exact
file transfers.

QM stages a small `aws` launcher during provision. Its first use installs and
verifies a pinned, checksum-checked AWS CLI v2 build if the VM lacks it, so
ordinary turns do not wait for the download. A custom snapshot with AWS CLI v2
in the standard location skips the download. Other deployment-layer tools are
installed from the layer's declared files during provision.
