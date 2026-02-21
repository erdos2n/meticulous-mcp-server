# Meticulous MCP — Tool Reference

Quick reference for all available tools. See [README](./README.md) for setup and schema details.

---

## Machine Control

### `get_device_info`
No parameters. Returns firmware, model, serial number, software version, and status.

### `execute_action`
| Param | Type | Required |
|-------|------|----------|
| `action` | `"start"` \| `"stop"` \| `"continue"` \| `"reset"` \| `"tare"` \| `"preheat"` \| `"calibration"` \| `"scale_master_calibration"` | Yes |

### `get_settings`
| Param | Type | Required |
|-------|------|----------|
| `setting_name` | string — e.g. `"auto_preheat"`, `"enable_sounds"` | No |

Omit `setting_name` to return all settings.

### `update_setting`
| Param | Type | Required |
|-------|------|----------|
| `settings` | object (partial) | Yes |

Available keys: `auto_preheat` (number), `auto_purge_after_shot` (bool), `auto_start_shot` (bool), `enable_sounds` (bool), `heating_timeout` (number), `partial_retraction` (number), `ssh_enabled` (bool), `update_channel` (string).

### `get_notifications`
| Param | Type | Required | Default |
|-------|------|----------|---------|
| `acknowledged` | bool | No | `false` |

`false` = pending notifications. `true` = already-acknowledged.

---

## Profile Management

### `list_profiles`
No parameters. Returns all profiles stored on the machine (name + UUID).

### `get_all_profiles`
No parameters. Returns all profiles with full stage/dynamics/trigger details.

### `get_profile`
| Param | Type | Required |
|-------|------|----------|
| `profile_id` | UUID string | Yes |

### `get_last_profile`
No parameters. Returns the currently active profile and when it was last loaded.

### `get_default_profiles`
No parameters. Returns built-in factory and community profiles.

### `load_profile`
| Param | Type | Required |
|-------|------|----------|
| `profile` | Full profile JSON object | Yes |

Validates schema before sending. Active until machine restarts or another profile is loaded. Use `save_profile` to persist.

### `load_profile_by_id`
| Param | Type | Required |
|-------|------|----------|
| `profile_id` | UUID string | Yes |

Profile must already be saved on the machine.

### `save_profile`
| Param | Type | Required |
|-------|------|----------|
| `profile` | Full profile JSON object | Yes |

Validates schema before saving. Permanently stores the profile on the machine.

### `delete_profile`
| Param | Type | Required |
|-------|------|----------|
| `profile_id` | UUID string | Yes |

---

## Shot History

### `get_shot_history`
No parameters. Returns metadata for all past shots (name, time, profile used, rating).

### `search_history`
| Param | Type | Required | Default |
|-------|------|----------|---------|
| `query` | string (profile name search) | No | — |
| `start_date` | string `"YYYY-MM-DD"` | No | — |
| `end_date` | string `"YYYY-MM-DD"` | No | — |
| `order_by` | `["profile"]` \| `["date"]` | No | — |
| `sort` | `"asc"` \| `"desc"` | No | `"desc"` |
| `max_results` | number | No | `20` |
| `include_data` | bool | No | `false` |

`include_data: true` includes full sensor arrays — large response, use carefully.

### `get_current_shot`
| Param | Type | Required | Default |
|-------|------|----------|---------|
| `verbosity` | `"summary"` \| `"full"` | No | `"summary"` |
| `max_points` | number | No | `40` |

Returns `null` if no shot is in progress.

### `get_last_shot`
| Param | Type | Required | Default |
|-------|------|----------|---------|
| `verbosity` | `"summary"` \| `"full"` | No | `"summary"` |
| `max_points` | number | No | `80` |

### `get_shot_statistics`
No parameters. Returns total shots pulled, shots per profile, and profile version counts.

### `rate_shot`
| Param | Type | Required |
|-------|------|----------|
| `shot_db_key` | number (from shot history) | Yes |
| `rating` | `"like"` \| `"dislike"` \| `null` | Yes |

Pass `null` to remove an existing rating.

### `search_historical_profiles`
| Param | Type | Required |
|-------|------|----------|
| `query` | string (profile name or partial) | Yes |

---

## Recipe Tools

### `validate_recipe`
| Param | Type | Required | Default |
|-------|------|----------|---------|
| `recipe` | profile JSON object | Yes | — |
| `auto_fix` | bool | No | `false` |

`auto_fix: true` fills in simple missing fields (id, author_id, version, etc.). Structural errors must be fixed manually.

### `get_shot_data_for_analysis`
| Param | Type | Required | Default |
|-------|------|----------|---------|
| `shot_db_key` | number | No | last shot |
| `verbosity` | `"summary"` \| `"compact"` \| `"full"` | No | `"compact"` |
| `max_points` | number | No | `120` |

---

## Grinder Context

Persists grinder model and setting per profile across sessions (stored in `~/.meticulous-mcp/grinder.json`).

### `set_grinder_context`
| Param | Type | Required |
|-------|------|----------|
| `profile_name` | string | Yes |
| `grinder` | string — e.g. `"DF83 V3"` | Yes |
| `setting` | number | Yes |
| `notes` | string — e.g. `"too coarse, dropping to 10.5 next"` | No |

### `get_grinder_context`
| Param | Type | Required |
|-------|------|----------|
| `profile_name` | string | No |

Omit `profile_name` to return grinder context for all profiles.
