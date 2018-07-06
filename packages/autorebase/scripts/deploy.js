/* eslint-env node */

"use strict";

require("loud-rejection/register");

const { createReadStream } = require("fs");

const envalid = require("envalid");
const fetch = require("node-fetch");

const zipPath = require.resolve("../lib/autorebase.zip");

const getBasicAuthorizationHeader = ({ username, password }) =>
  `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

const getConfig = env => {
  // See https://docs.microsoft.com/en-us/azure/azure-functions/deployment-zip-push#rest
  const {
    AZURE_APP_NAME: appName,
    AZURE_PASSWORD: password,
    AZURE_USERNAME: username,
  } = envalid.cleanEnv(
    env,
    {
      AZURE_APP_NAME: envalid.str({
        desc: "Name of the Function App.",
      }),
      AZURE_PASSWORD: envalid.str({
        docs:
          "https://docs.microsoft.com/en-us/azure/app-service/app-service-deployment-credentials#userscope.",
      }),
      AZURE_USERNAME: envalid.str({
        docs:
          "https://docs.microsoft.com/en-us/azure/app-service/app-service-deployment-credentials#userscope.",
      }),
    },
    { strict: true }
  );

  return { appName, password, username };
};

/* eslint-disable no-console, no-process-env */
(async ({ appName, password, username }) => {
  try {
    const response = await fetch(
      `https://${appName}.scm.azurewebsites.net/api/zipdeploy`,
      {
        body: createReadStream(zipPath),
        headers: {
          Authorization: getBasicAuthorizationHeader({
            password,
            username,
          }),
        },
        method: "POST",
      }
    );
    const message = await response.text();
    if (response.status !== 200) {
      throw new Error(message);
    }
    console.log("Deployment successful");
  } catch (error) {
    console.error(error);
    throw new Error("Deployment failed");
  }
})(getConfig(process.env));
