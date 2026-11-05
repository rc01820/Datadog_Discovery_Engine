/** "I want to… → search this" recipes for the Help page. Every `q` is validated against the API (see README). */
export interface Recipe {
  want: string;
  q: string;
  note?: string;
}

export interface RecipeGroup {
  id: string;
  title: string;
  recipes: Recipe[];
}

export const RECIPES: RecipeGroup[] = [
  {
    id: "ip",
    title: "IP addresses",
    recipes: [
      { want: "Find the node with IP 10.10.50.21 (exactly that address)", q: 'ip:"10.10.50.21"', note: "Quotes = exact. Without quotes, ip:10.10.50.21 also matches 10.10.50.210–219." },
      { want: "Find anything that mentions 10.10.50.21 anywhere", q: "10.10.50.21", note: "Free text searches every field, including IPs, aliases and tags." },
      { want: "Find every node in the 10.10.50.x range", q: "ip:10.10.50.*" },
      { want: "Find every node in a subnet using CIDR", q: "10.10.50.0/24", note: "Any IPv4/IPv6 CIDR works, with or without ip:." },
      { want: "Find nodes in a large private range", q: "ip:10.0.0.0/8" },
      { want: "Find nodes whose IP ends in .10", q: "ip:*.10" },
      { want: "Find nodes in either of two subnets", q: "10.10.50.0/24 OR 10.10.51.0/24" },
      { want: "Find nodes in a subnet except network devices", q: "10.10.50.0/24 -type:device" },
      { want: "Find addresses with a regular expression (10.10.50.20–29)", q: "regex:ip:^10\\.10\\.50\\.2[0-9]$" },
      { want: "Find infrastructure that has no IP recorded", q: "type:host missing:ip" },
      { want: "Investigate an IP that may be used by more than one resource", q: 'ip:"10.10.50.40"', note: "Also see Reports › Duplicate IP addresses." },
    ],
  },
  {
    id: "name",
    title: "Names & hostnames",
    recipes: [
      { want: "Find the node named eoc-app-xyz-01 (exact name)", q: 'name:"eoc-app-xyz-01"' },
      { want: "Find nodes whose name contains “xyz”", q: "name:xyz" },
      { want: "Find nodes whose name starts with eoc-", q: "name:eoc-*" },
      { want: "Find nodes whose name ends with -01", q: "name:*-01" },
      { want: "Find names with exactly two characters after “eoc-web-”", q: "name:eoc-web-??" },
      { want: "Find names matching a strict pattern (3 letters, -core-sw, 2 digits: bos-core-sw01)", q: "regex:name:^[a-z]{3}-core-sw\\d{2}$" },
      { want: "Find eoc app or db servers with one regex", q: "name:/^eoc-(app|db)-/" },
      { want: "Find a name that contains spaces", q: 'name:"XYZ - Process Status"', note: "Values with spaces must be quoted." },
      { want: "Find Boston nodes but not the firewalls", q: "name:bos-* -name:*fw*" },
    ],
  },
  {
    id: "alias",
    title: "AWS & host aliases",
    recipes: [
      { want: "Find the EC2 node with instance ID i-0a1b2c3d4e5f6g7h8", q: "i-0a1b2c3d4e5f6g7h8", note: "Free text searches aliases too; the row shows “alias: …” when that is what matched." },
      { want: "Find nodes by an instance ID prefix", q: "alias:i-0a1b*" },
      { want: "Find a node by its EC2 private DNS name", q: "alias:ip-10-10-50-21.ec2.internal" },
      { want: "Find every node with an EC2 internal DNS alias", q: "alias:*.ec2.internal" },
      { want: "Find a node by its AWS Name tag", q: "alias:EOC-XYZ-App-Primary" },
      { want: "Find an RDS database by endpoint", q: "alias:*.rds.amazonaws.com" },
      { want: "Use the aws: shorthand (same as alias:)", q: "aws:i-09f8*" },
      { want: "Find hosts that have no alias at all", q: "type:host missing:alias" },
    ],
  },
  {
    id: "tags",
    title: "Tags",
    recipes: [
      { want: "Find everything tagged app:xyz", q: "tag:app:xyz", note: "Shorthand: app:xyz (any key:value that is not a built-in field is treated as a tag)." },
      { want: "Find things tagged app:xyz AND costcenter:abc (both tags)", q: "tag:app:xyz AND tag:costcenter:abc", note: "Shorthand: app:xyz costcenter:abc — adjacent terms are ANDed." },
      { want: "Same thing, shorthand form", q: "app:xyz costcenter:abc" },
      { want: "Working demo version: app:xyz AND costcenter:eoc", q: "app:xyz costcenter:eoc -type:tag", note: "costcenter:abc above is a placeholder; the demo inventory uses costcenter:eoc and costcenter:bos." },
      { want: "Find things tagged app:xyz OR costcenter:abc (either tag)", q: "app:xyz OR costcenter:abc" },
      { want: "Find app:xyz resources that are NOT in dev", q: "app:xyz -env:dev" },
      { want: "Find anything that has an app tag (any value)", q: "tag:app" },
      { want: "Find every app whose name starts with x", q: "tag:app:x*" },
      { want: "Find app:xyz OR app:abc, but only in prod", q: "(app:xyz OR app:abc) AND env:prod" },
      { want: "Find nodes tagged for Boston", q: "geolocation:boston" },
      { want: "Find nodes in a Kubernetes cluster", q: "kube_cluster:lab-1" },
      { want: "Find resources missing a costcenter tag", q: "missing:costcenter -type:tag" },
      { want: "Find hosts missing env OR app tags", q: "type:host (missing:env OR missing:app)" },
      { want: "Hide the Tag rows themselves from tag searches", q: "app:xyz -type:tag", note: "Tag searches also return the Tag entity (e.g. “app:xyz”); exclude it with -type:tag." },
    ],
  },
  {
    id: "types",
    title: "Resource types",
    recipes: [
      { want: "List all hosts", q: "type:host" },
      { want: "List all network devices", q: "type:device" },
      { want: "Find Cisco network devices", q: "type:device AND vendor:cisco" },
      { want: "Find switches (device sub-type tag)", q: "type:switch", note: "type: values that are not resource types fall back to the tag type:<value>." },
      { want: "Find firewalls or routers", q: "type:firewall OR type:router" },
      { want: "List synthetic tests for app xyz", q: "type:synthetic app:xyz" },
      { want: "List dashboards", q: "type:dashboard" },
      { want: "List VMware virtual machines", q: "type:vmware" },
      { want: "List cloud resources in AWS", q: "type:cloud cloud:aws" },
      { want: "List APM / catalog services owned by the NOC team", q: "type:service team:noc" },
    ],
  },
  {
    id: "monitors",
    title: "Monitors & status",
    recipes: [
      { want: "Find everything currently alerting", q: "status:alert" },
      { want: "Find alerting or warning resources outside the lab", q: "(status:alert OR status:warn) -env:lab" },
      { want: "Find alerting monitors", q: "type:monitor AND status:alert" },
      { want: "Find monitors for app xyz that are not OK", q: "type:monitor app:xyz -status:ok" },
      { want: "Find muted monitors", q: "type:monitor status:muted" },
      { want: "Find monitors in No Data / unknown state", q: "type:monitor status:unknown" },
      { want: "Find hosts that are down", q: "type:host status:down" },
      { want: "Find a monitor by its numeric ID", q: "id:1000100" },
      { want: "Find monitors whose name mentions CPU", q: "type:monitor name:cpu" },
    ],
  },
  {
    id: "platform",
    title: "OS, agent & vendor",
    recipes: [
      { want: "Find Windows servers", q: "os:windows" },
      { want: "Find Windows Server 2012 (end of life)", q: 'os:"Windows Server 2012 R2"' },
      { want: "Find Linux hosts in prod", q: "type:host os:linux env:prod" },
      { want: "Find hosts on Datadog Agent 6.x", q: "agent:6.*" },
      { want: "Find hosts on an exact agent version", q: 'agent:"7.75.3"' },
      { want: "Find hosts without an agent (agentless)", q: "type:host missing:agent" },
      { want: "Find Arista or Aruba gear", q: "vendor:arista OR vendor:aruba" },
      { want: "Find devices by model", q: "model:catalyst*" },
    ],
  },
  {
    id: "k8s",
    title: "Kubernetes & containers",
    recipes: [
      { want: "List Kubernetes clusters", q: "type:cluster" },
      { want: "List every pod in the lab-1 cluster", q: "type:pod kube_cluster_name:lab-1" },
      { want: "Find pods for a deployment", q: "type:pod kube_deployment:xyz-api" },
      { want: "Find everything in a namespace", q: "kube_namespace:xyz -type:tag" },
      { want: "Find pods that are not fully running", q: "type:pod -status:ok" },
      { want: "Find exited / crashed containers", q: "type:container status:alert" },
      { want: "Find containers running a given image", q: "type:container image_name:nginx" },
      { want: "Find a container by (short) container ID", q: "alias:3f2a9c*", note: "Container IDs and their 12-character short form are indexed as aliases." },
      { want: "Find containers running on a specific host", q: "type:container host:flux-apps", note: "Or open the host in the inspector › Related › Containers & pods on this host." },
      { want: "Find Datadog Agent containers", q: "type:container image_name:*datadog*" },
    ],
  },
  {
    id: "interfaces",
    title: "Network interfaces",
    recipes: [
      { want: "List all interfaces of a device", q: "type:interface device_name:bos-core-sw01" },
      { want: "Find interfaces that are down", q: "type:interface status:down" },
      { want: "Find an interface by MAC address", q: "mac:00:1a:2b:*", note: "Bare MACs work too, e.g. 00:1a:2b:3c:4d:5e. Interface descriptions are searchable as aliases." },
      { want: "Find which interface holds an IP (e.g. an SVI / gateway)", q: 'type:interface ip:"10.10.50.1"' },
      { want: "Find uplinks by description", q: "type:interface alias:*uplink*" },
    ],
  },
  {
    id: "databases",
    title: "Databases",
    recipes: [
      { want: "List every database", q: "type:database" },
      { want: "List PostgreSQL databases", q: "type:database db_engine:postgresql" },
      { want: "Find Redis instances", q: "type:database vendor:redis" },
      { want: "Find databases for app xyz", q: "type:database app:xyz" },
      { want: "Find databases that are not OK", q: "type:database -status:ok" },
    ],
  },
  {
    id: "aws-services",
    title: "AWS services",
    recipes: [
      { want: "List every AWS resource", q: "cloud:aws" },
      { want: "List Lambda functions", q: "aws_service:lambda" },
      { want: "List S3 buckets", q: "aws_service:s3" },
      { want: "List DynamoDB tables, SQS queues and SNS topics", q: "aws_service:dynamodb OR aws_service:sqs OR aws_service:sns" },
      { want: "Find load balancers (ALB, NLB, classic ELB)", q: "aws_service:alb OR aws_service:nlb OR aws_service:elb" },
      { want: "Find AWS resources in one region", q: "cloud:aws region:us-east-1" },
      { want: "Find AWS resources for app xyz", q: "cloud:aws app:xyz" },
      { want: "Find everything in an AWS account", q: "aws_account:723527124594" },
    ],
  },
  {
    id: "combined",
    title: "Combined & advanced",
    recipes: [
      { want: "The mockup query: subnet OR eoc names OR app xyz", q: "ip:10.10.50.* OR name:eoc* OR tag:app:xyz" },
      { want: "Prod web tier for app xyz", q: "app:xyz env:prod role:web" },
      { want: "Prod databases that are not healthy", q: "role:db env:prod -status:ok" },
      { want: "Everything for app xyz except monitors and tags", q: "app:xyz -type:monitor -type:tag" },
      { want: "Boston infrastructure that is alerting", q: "geolocation:boston (status:alert OR status:warn)" },
      { want: "Only demo records / only live Datadog records", q: "source:DEMO", note: "Use source:Datadog for synced records." },
      { want: "Nested logic: (A or B) and not (C or D)", q: "(app:xyz OR app:abc) -(env:dev OR env:lab)" },
      { want: "Regex across every field", q: "regex:^(bos|nyc)-" },
    ],
  },
];
