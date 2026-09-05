# References

Citations used across the masterplan. Accessed September 2026. Snippets were verified via web search; direct observations are marked.

1. Open Charge Alliance — _OCPP protocol overview and versions_. https://openchargealliance.org/protocols/open-charge-point-protocol
2. ocpp.md — _OCPP 2.0.1 core message flows; TransactionEvent lifecycle_. https://ocpp.md/ocpp-2.0.1/sequences
3. OCPP Lab — _What is OCPP? 1.6 vs 2.0.1 differences (security, device model, transactions)_. https://www.ocpplab.com/blog/what-is-ocpp
4. eLink Power — _OCPP 1.6J: JSON over WebSockets; most widely deployed version_. https://www.elinkpower.com/news/ocpp-open-charge-point-protocol-from-1-5-to-2-1-in-ev-charging
5. AWS Industries Blog — _Building a Charging Station Management System with AWS_. https://aws.amazon.com/blogs/industries/building-a-charging-station-management-system-with-aws
6. Bluepes — _EV Charging Network Scalability: "At low scale, a monolithic CSMS with a relational database."_ https://bluepes.com/blog/scaling-ev-charging-networks-from-infrastructure-to-intelligence
7. TigerData (Timescale) — _EV Charging Management System: Architecture, OCPP Data_ (meter values, CDRs, status events, config as distinct workloads). https://www.tigerdata.com/learn/ev-charging-station-data-management
8. MyDBOPS — _Managed Database Services for EV Charging Platforms_ ("15–30 second telemetry writes with PCI-DSS billing data"). https://www.mydbops.com/blog/managed-database-services-for-ev-charging-network-platforms
9. arXiv 2601.10861 — _Actionable Performance Metrics for EV Charging Sites_ (Fault Time, Fault-Reason Time, Unreachable Time). https://arxiv.org/html/2601.10861v1
10. steve-community/steve — _SteVe: open-source OCPP server since 2013_. https://github.com/steve-community/steve
11. EVRoaming Foundation — _OCPI: Open Charge Point Interface (roaming, tariffs, CDRs)_. https://evroaming.org/ocpi
12. AmpUp — _Time-of-Use EV Charging Rates for Commercial Sites_. https://www.ampup.io/blog/time-of-use-ev-charging-rates
13. EVgo — _Pricing and Plans (per kWh, session fees, ToU)_. https://www.evgo.com/pricing
14. eMobler — _EV Charging Tariffs: Models, Margins, and Control_. https://emabler.com/resource/ev-charging-tariffs-explained
15. Pulse Energy — _Understanding Different Levels and Types of EV Charging (India connector landscape)_. https://pulseenergy.io/blog/ev-charger-types
16. Versinetic — _EV Charging Connector Types Guide (Bharat AC001/DC001, Type 2, CCS2)_. https://www.versinetic.com/news-blog/ev-charging-connector-types-guide
17. Central Electricity Authority, India — _EV Charging Standards and Regulations_. https://cea.nic.in/ev-charging-standards/
18. Down To Earth — _India's revised EV charging guidelines (3x3 km grid rule, highway spacing)_. https://www.downtoearth.org.in/governance/what-do-indias-evolving-ev-charging-station-guidelines-mean-for-operators
19. TigerData docs — _Continuous aggregates, compression, retention policies_. https://www.tigerdata.com/docs/learn/continuous-aggregates
20. TigerData — _The Best Time-Series Databases Compared (InfluxDB purpose-built vs TimescaleDB SQL)_. https://www.tigerdata.com/learn/the-best-time-series-databases-compared
21. OneUptime — _How to Compare MongoDB Time Series vs InfluxDB vs TimescaleDB_ (write throughput vs SQL semantics). https://oneuptime.com/blog/post/2026-03-31-mongodb-compare-time-series-influxdb-timescaledb/view
22. ClickHouse Engineering — _Unifying OLTP and OLAP: HTAP, zero-ETL_. https://clickhouse.com/resources/engineering/unifying-oltp-and-olap
23. AmpControl — _How to start an OCPP charging session (StartTransaction flow)_. https://www.ampcontrol.io/ocpp-guide/how-to-start-an-ocpp-charging-session-with-starttransaction
24. Open Charge Alliance — _Using ISO 15118 Plug & Charge with OCPP_. https://openchargealliance.org/ocpp-info-whitepapers/using-iso-15118-plug-charge-with-ocpp-1-6
25. acmvit.in — _Direct observation of served HTML_ (Astro components, Tailwind utilities, PolySans + Inter, #FFFDD0 palette, video sections). https://www.acmvit.in/
26. Pixel Show — _Designing Data-Dense Dashboards (elevation contrast in dark mode)_. https://pixel-show.com/blog/designing-data-dense-dashboards
27. sanj.dev — _CockroachDB vs TiDB vs YugabyteDB (distributed SQL trade-offs; niche at small scale)_. https://sanj.dev/post/distributed-sql-databases-comparison
28. JusDB — _TimescaleDB 2026: Hypertables, Continuous Aggregates, 10–20x compression_. https://www.jusdb.com/blog/timescaledb-hypertables-continuous-aggregates-guide
29. AmpUp — _Optimize EV Charging Performance with KPIs (uptime, success rate)_. https://www.ampup.io/blog/ev-charging-kpi-optimization
30. CyberSwitching — _5 Types of Metrics To Analyze EV Charging Performance_. https://cyberswitching.com/5-types-metrics-analyze-ev-charging-performance/

**Primary standards & documentation** (consulted for design correctness): OCPP 1.6 specification (Open Charge Alliance), PostgreSQL/TimescaleDB official documentation, Oracle Database 23ai documentation (identity columns, materialized views, DBMS_SCHEDULER, Virtual Private considerations for grants), OWASP Authentication Cheat Sheet (Argon2id parameters), node-oracledb documentation (connection pooling, bind variables).
