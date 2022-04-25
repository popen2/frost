# Frost ❄️

Frost is an app for people using AWS SSO.

AWS SSO requires users to run the `aws sso login` command every once in while to refresh their credentials. Also, users have to setup their workstations by running `aws configure sso` and answering a bunch of questions.

This app tries to automate the process by only requiring the AWS SSO start URL, then getting all the rest of the details directly from AWS SSO's API.

Once a user has successfully logged-in, Frost will create a `~/.aws/config` file with predictable profile names (see below).

When using [AWS SSO with federation](https://docs.aws.amazon.com/singlesignon/latest/userguide/samlfederationconcept.html), such as Google Workspace, Frost can refresh credentials without interrupting the user in most cases.

## Profile Name Generation

Profile names are generated automatically using the AWS account name and the permission set name. For example, let's assume a user is defined with the following accounts and permission sets:

| AWS Account     | Permission Sets                      |
| --------------- | ------------------------------------ |
| ACME Main       | AdministratorAccess, PowerUserAccess |
| ACME Testing    | PowerUserAccess, BillingAccess       |
| ACME Production | AdministratorAccess, PowerUserAccess |

Then, the following profiles would be generated:

-   acme-main-administratoraccess
-   acme-main-poweruseraccess
-   acme-testing-poweruseraccess
-   acme-testing-billingaccess
-   acme-production-administratoraccess
-   acme-production-poweruseraccess

### Short Names

This is fine, but the names could be shortened by adding #short-names to the AWS account name.

To do that, [Change the AWS account names](https://aws.amazon.com/premiumsupport/knowledge-center/change-organizations-name/) you wish to shorten.

Using the example above, let's say we've changed the account names to:

| AWS Account             | Permission Sets                      |
| ----------------------- | ------------------------------------ |
| ACME Main (#main)       | AdministratorAccess, PowerUserAccess |
| ACME Testing (#test)    | PowerUserAccess, BillingAccess       |
| ACME Production (#prod) | AdministratorAccess, PowerUserAccess |

The profiles would now be named:

-   main-administratoraccess
-   main-poweruseraccess
-   test-poweruseraccess
-   test-billingaccess
-   prod-administratoraccess
-   prod-poweruseraccess

As for permission set names, you should try to use short names for those. Still, in case you've already used the predefined permission set names, Frost will automatically shorten them by:

| Predefined Permission Set Name | Shortened Name |
| ------------------------------ | -------------- |
| AdministratorAccess            | admin          |
| Billing                        | billing        |
| DatabaseAdministrator          | dba            |
| DataScientist                  | datasci        |
| NetworkAdministrator           | netadmin       |
| PowerUserAccess                | poweruser      |
| SecurityAudit                  | secaudit       |
| SupportUser                    | support        |
| SystemAdministrator            | sysadmin       |
| ViewOnlyAccess                 | viewonly       |

So we end up with these profiles:

-   main-admin
-   main-poweruser
-   test-poweruser
-   test-billing
-   prod-admin
-   prod-poweruser

### Region Selection

In some cases an AWS account should have a different default region than the one used by AWS SSO.

For example, your AWS SSO may have been created in `us-east-1` but one of the accounts has all of its services in `eu-west-1`. In this case, you'd like `~/.aws/config` to have `region = eu-west-1` for that specific account so that users don't have to pass a region to every CLI/API call.

To do that, add an `@region` to the account name.

In the example above, if the `ACME Testing` account is mainly used in `eu-west-1` we'd rename it to `ACME Testing (#test @eu-west-1)`.

## EKS Cluster Discovery

In addition to refreshing credentials automatically, Frost will scan for EKS clusters every time it obtains new credentials. The clusters will be saved in `~/.kube/config`.

The scan works by getting the list of regions, then trying to list EKS clusters in each region with every profile detected from AWS SSO.

This method may result in some errors as it makes sense that some profiles don't have access to EKS. This is fine as only successful calls to `eks:DescribeCluster` will result in an entry in `~/.kube/config`.

Authentication to the clusters uses a copy of [AWS IAM Authenticator](https://github.com/kubernetes-sigs/aws-iam-authenticator) embedded within the app. This allows using the app without installing AWS CLI.
