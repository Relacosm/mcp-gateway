{{- define "store.labels" -}}
app.kubernetes.io/part-of: platform
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "store.db" -}}{{ .Release.Name }}-store-mariadb{{- end -}}
{{- define "store.wp" -}}{{ .Release.Name }}-store-wordpress{{- end -}}
{{- define "store.url" -}}
{{- if .Values.global.ingress.tls -}}https{{- else -}}http{{- end -}}://{{ .Values.host }}.{{ .Values.global.domain }}
{{- end -}}

{{/* DB connection env shared by WordPress and the setup Job. */}}
{{- define "store.wpDbEnv" -}}
- name: WORDPRESS_DB_HOST
  value: {{ include "store.db" . }}
- name: WORDPRESS_DB_NAME
  value: wordpress
- name: WORDPRESS_DB_USER
  value: wordpress
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Release.Name }}-store-db, key: password }
{{- end -}}
