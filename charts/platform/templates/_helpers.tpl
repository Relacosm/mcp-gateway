{{/*
Resolve one secret value, in order:
  1. the value passed in through Helm values,
  2. the value already stored in the cluster (so upgrades keep it),
  3. a new random value (prefix + random alphanumerics), unless "generate" is false.
Usage: include "platform.secret" (dict "ctx" $ "name" "x" "key" "y" "value" "" "length" 32 "prefix" "")
*/}}
{{- define "platform.secret" -}}
{{- $obj := lookup "v1" "Secret" .ctx.Release.Namespace .name -}}
{{- $data := dig "data" (dict) $obj -}}
{{- if .value -}}
{{- .value -}}
{{- else if hasKey $data .key -}}
{{- index $data .key | b64dec -}}
{{- else if ne (toString .generate) "false" -}}
{{- printf "%s%s" (.prefix | default "") (randAlphaNum (int (.length | default 32))) -}}
{{- end -}}
{{- end -}}

{{- define "platform.labels" -}}
app.kubernetes.io/part-of: platform
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
