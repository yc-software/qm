export const amazonQAlarm = {
  type: "message",
  subtype: "bot_message",
  text: "",
  ts: "1790000000.000100",
  bot_id: "BAMAZONQ",
  bot_profile: { name: "Amazon Q Developer", app_id: "A0AMAZONQ" },
  attachments: [
    {
      id: 1,
      color: "#D13212",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*<https://console.aws.amazon.com/cloudwatch/home#alarmsV2:alarm/qm-fleet-http-error-rate|:rotating_light: CloudWatch Alarm | qm-fleet-http-error-rate | us-west-2 | Account: 111111111111>*",
          },
        },
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Latest Update*: :rotating_light: Alarm qm-fleet-http-error-rate is in ALARM state",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Threshold Crossed: 2 out of the last 3 datapoints were greater than or equal to the threshold (5.0).",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "list-dashboards",
              text: { type: "plain_text", text: "List dashboards" },
              value: '{"command":"cloudwatch list-dashboards"}',
            },
          ],
        },
      ],
    },
  ],
};

export const amazonQAlarmText = [
  "*<https://console.aws.amazon.com/cloudwatch/home#alarmsV2:alarm/qm-fleet-http-error-rate|:rotating_light: CloudWatch Alarm | qm-fleet-http-error-rate | us-west-2 | Account: 111111111111>*",
  "*Latest Update*: :rotating_light: Alarm qm-fleet-http-error-rate is in ALARM state",
  "Threshold Crossed: 2 out of the last 3 datapoints were greater than or equal to the threshold (5.0).",
].join("\n");
