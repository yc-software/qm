ARG BASE=qm-sandbox-base:dev
FROM ${BASE}

COPY aws/microvm-agent/agent.mjs /opt/microvm-agent/agent.mjs

ENV HOME=/root
WORKDIR /root
EXPOSE 8080
CMD ["node", "/opt/microvm-agent/agent.mjs"]
