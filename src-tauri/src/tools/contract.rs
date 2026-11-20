//! Contract drift guard for connector types crossing the Tauri IPC boundary.
//!
//! `webview/types/connector-contract.json` describes the wire shapes that
//! `webview/types/index.ts` mirrors by hand. The tests here serialize representative Rust values
//! and assert they still conform to that file; `scripts/check-connector-contract.mjs` asserts
//! the TypeScript declarations do too. A field renamed or removed on either side makes one of
//! the two checks fail.
//!
//! Run with `cargo test --manifest-path src-tauri/Cargo.toml --features test-utils`.

use super::auth::{
    Activity, AuthMechanism, ConnectorStatus, LuminanceInfo, McpTransportInfo, ProtonBridgeInfo,
    Readiness, TokenSource,
};
use super::connector_state::ToolPolicy;
use super::connectors::mcp::{CustomHeader, HttpAuth, McpServerConfig, McpTransport};
use super::exposure::ApprovalReason;
use super::registry::{Capabilities, ConnectorManifest, ToolDefinition};
use crate::schedules::bridge::ScheduleToolContext;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

const CONTRACT_JSON: &str = include_str!("../../../webview/types/connector-contract.json");

fn contract() -> Value {
    serde_json::from_str(CONTRACT_JSON).expect("connector contract is valid JSON")
}

fn schema_for<'a>(contract: &'a Value, name: &str) -> &'a Value {
    contract["types"]
        .get(name)
        .unwrap_or_else(|| panic!("connector contract has no type {name}"))
}

fn check_fields(
    contract: &Value,
    path: &str,
    fields: &Map<String, Value>,
    object: &Map<String, Value>,
) {
    for (name, field_schema) in fields {
        match object.get(name) {
            Some(value) => check(contract, &format!("{path}.{name}"), field_schema, value),
            None => assert!(
                field_schema
                    .get("optional")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                "{path}: missing field {name}"
            ),
        }
    }
    for key in object.keys() {
        assert!(
            fields.contains_key(key),
            "{path}: field {key} is not in the contract; add it to connector-contract.json"
        );
    }
}

fn check(contract: &Value, path: &str, schema: &Value, value: &Value) {
    if value.is_null() {
        assert!(
            schema
                .get("nullable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "{path}: unexpected null"
        );
        return;
    }

    let kind = schema
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{path}: contract entry has no kind"));

    match kind {
        "any" => {}
        "scalar" => {
            let expected = schema["type"]
                .as_str()
                .unwrap_or_else(|| panic!("{path}: scalar has no type"));
            let matches = match expected {
                "string" => value.is_string(),
                "boolean" => value.is_boolean(),
                "number" => value.is_number(),
                other => panic!("{path}: unknown scalar type {other}"),
            };
            assert!(matches, "{path}: expected {expected}, got {value}");
        }
        "ref" => {
            let name = schema["ref"]
                .as_str()
                .unwrap_or_else(|| panic!("{path}: ref has no target"));
            check(contract, path, schema_for(contract, name), value);
        }
        "array" => {
            let items = schema
                .get("items")
                .unwrap_or_else(|| panic!("{path}: array has no items"));
            let array = value
                .as_array()
                .unwrap_or_else(|| panic!("{path}: expected an array, got {value}"));
            for (index, item) in array.iter().enumerate() {
                check(contract, &format!("{path}[{index}]"), items, item);
            }
        }
        "map" => {
            let values = schema
                .get("values")
                .unwrap_or_else(|| panic!("{path}: map has no values"));
            let object = value
                .as_object()
                .unwrap_or_else(|| panic!("{path}: expected a map, got {value}"));
            for (key, item) in object {
                check(contract, &format!("{path}.{key}"), values, item);
            }
        }
        "string_enum" => {
            let text = value
                .as_str()
                .unwrap_or_else(|| panic!("{path}: expected a string, got {value}"));
            let allowed = schema["values"]
                .as_array()
                .unwrap_or_else(|| panic!("{path}: string_enum has no values"));
            assert!(
                allowed.iter().any(|item| item.as_str() == Some(text)),
                "{path}: {text:?} is not one of {allowed:?}"
            );
        }
        "object" => {
            let object = value
                .as_object()
                .unwrap_or_else(|| panic!("{path}: expected an object, got {value}"));
            let fields = schema["fields"]
                .as_object()
                .unwrap_or_else(|| panic!("{path}: object has no fields"));
            check_fields(contract, path, fields, object);
        }
        "tagged_union" => {
            let object = value
                .as_object()
                .unwrap_or_else(|| panic!("{path}: expected an object, got {value}"));
            let tag = schema["tag"]
                .as_str()
                .unwrap_or_else(|| panic!("{path}: tagged_union has no tag"));
            let tag_value = object
                .get(tag)
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("{path}: missing tag {tag}"));
            let variants = schema["variants"]
                .as_object()
                .unwrap_or_else(|| panic!("{path}: tagged_union has no variants"));
            let fields = variants
                .get(tag_value)
                .unwrap_or_else(|| panic!("{path}: unknown variant {tag_value}"))
                .as_object()
                .unwrap_or_else(|| panic!("{path}: variant {tag_value} has no fields"));
            let mut expected = fields.clone();
            expected.insert(tag.to_string(), json!({ "kind": "any" }));
            check_fields(contract, path, &expected, object);
        }
        other => panic!("{path}: unknown contract kind {other}"),
    }
}

fn assert_serializes<T: serde::Serialize>(name: &str, value: T) {
    let contract = contract();
    let serialized = serde_json::to_value(value).expect("connector value serializes");
    check(&contract, name, schema_for(&contract, name), &serialized);
}

fn sample_tool() -> ToolDefinition {
    ToolDefinition {
        name: "read".into(),
        title: Some("Read".into()),
        description: "Read a value".into(),
        input_schema: json!({ "type": "object", "properties": {} }),
        read_only: Some(true),
        open_world: Some(false),
        policy: ToolPolicy::AutoApprove,
    }
}

fn sample_manifest() -> ConnectorManifest {
    ConnectorManifest {
        id: "example".into(),
        display_name: "Example".into(),
        description: Some("An example connector".into()),
        version: "1.0.0".into(),
        icon: Some("data:image/png;base64,AA==".into()),
        auth: AuthMechanism::ApiKey {
            env_var: "EXAMPLE_API_KEY".into(),
        },
        capabilities: Capabilities {
            credentials: true,
            session: true,
        },
        tools: vec![sample_tool()],
        always_allowed: vec!["read".into()],
        enabled: true,
        readiness: Readiness::Ready,
        activity: Some(Activity::Succeeded),
        status: ConnectorStatus::Ready,
    }
}

#[test]
fn manifest_and_tool_definition_match_contract() {
    assert_serializes("ConnectorManifest", sample_manifest());
    assert_serializes("ToolDefinition", sample_tool());
    assert_serializes(
        "Capabilities",
        Capabilities {
            credentials: true,
            session: false,
        },
    );
}

#[test]
fn readiness_activity_status_and_policy_match_contract() {
    for readiness in [Readiness::Ready, Readiness::blocked("offline")] {
        assert_serializes("Readiness", readiness);
    }
    for activity in [
        Activity::Untried,
        Activity::Succeeded,
        Activity::Failed {
            error: "connection refused".into(),
        },
    ] {
        assert_serializes("Activity", activity);
    }
    for status in [
        ConnectorStatus::Ready,
        ConnectorStatus::Warning {
            error: "slow".into(),
        },
        ConnectorStatus::NotReady {
            reason: "Not connected yet".into(),
        },
    ] {
        assert_serializes("ConnectorStatus", status);
    }
    for policy in [ToolPolicy::AutoApprove, ToolPolicy::Ask, ToolPolicy::Disable] {
        assert_serializes("ToolPolicy", policy);
    }
}

#[test]
fn auth_mechanisms_match_contract() {
    let stdio = McpTransportInfo::Stdio {
        command: "npx".into(),
        args: vec!["-y".into(), "example".into()],
        env: HashMap::from([("EXAMPLE".into(), "1".into())]),
        secret_env: vec!["EXAMPLE_TOKEN".into()],
    };
    let mechanisms = vec![
        AuthMechanism::None,
        AuthMechanism::ApiKey {
            env_var: "EXAMPLE_KEY".into(),
        },
        AuthMechanism::BearerToken {
            source: TokenSource::Keychain {
                service: "lumo".into(),
                account: "example".into(),
            },
        },
        AuthMechanism::OAuth2 {
            client_id_env: "CLIENT_ID".into(),
            client_secret_env: "CLIENT_SECRET".into(),
            auth_url: "https://example.test/authorize".into(),
            token_url: "https://example.test/token".into(),
            scopes: vec!["read".into()],
            redirect_port: 43117,
        },
        AuthMechanism::McpServer {
            transport: stdio,
        },
        AuthMechanism::ProtonBridge {
            config: Some(ProtonBridgeInfo {
                imap_port: 1143,
                smtp_port: 1025,
                username: "user@example.test".into(),
                imap_security: "starttls".into(),
                smtp_security: "starttls".into(),
            }),
        },
        AuthMechanism::ProtonBridge { config: None },
        AuthMechanism::Luminance {
            config: Some(LuminanceInfo {
                instance_url: "https://luminance.example.test".into(),
                auth: "token".into(),
            }),
        },
        AuthMechanism::Luminance { config: None },
    ];

    for mechanism in mechanisms {
        assert_serializes("AuthMechanism", mechanism);
    }
}

#[test]
fn approval_reason_matches_contract() {
    assert_serializes(
        "ApprovalReason",
        ApprovalReason {
            kind: "untrusted_content",
            sources: vec!["mail", "web"],
            destination: Some("example.test".into()),
        },
    );
    assert_serializes(
        "ApprovalReason",
        ApprovalReason {
            kind: "hidden_text",
            sources: vec!["connector"],
            destination: None,
        },
    );
}

#[test]
fn command_shapes_match_contract() {
    assert_serializes(
        "ScheduleToolContext",
        ScheduleToolContext {
            connection_id: "connection".into(),
            run_id: "run".into(),
        },
    );

    for auth in [
        HttpAuth::Oauth {
            scopes: vec!["read".into()],
            client_id: Some("client".into()),
            resource: Some("https://example.test".into()),
            authorize_params: HashMap::from([("access_type".into(), "offline".into())]),
        },
        HttpAuth::Token {
            scheme: "Bearer".into(),
        },
        HttpAuth::Headers {
            headers: vec![CustomHeader {
                name: "Authorization".into(),
                prefix: "Bearer ".into(),
            }],
        },
        HttpAuth::None,
    ] {
        assert_serializes("HttpAuth", auth);
    }

    assert_serializes(
        "McpServerConfig",
        McpServerConfig {
            id: "stdio".into(),
            display_name: "Stdio".into(),
            description: Some("A stdio server".into()),
            transport: McpTransport::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "example".into()],
                env: HashMap::from([("EXAMPLE".into(), "1".into())]),
                secret_env: vec!["EXAMPLE_TOKEN".into()],
            },
        },
    );
    assert_serializes(
        "McpServerConfig",
        McpServerConfig {
            id: "http".into(),
            display_name: "HTTP".into(),
            description: None,
            transport: McpTransport::Http {
                url: "https://example.test/mcp".into(),
                auth: HttpAuth::Oauth {
                    scopes: vec!["read".into()],
                    client_id: None,
                    resource: None,
                    authorize_params: HashMap::new(),
                },
                request_headers: HashMap::from([("X-Example".into(), "1".into())]),
            },
        },
    );
}
