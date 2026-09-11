{{/*
Helpers keep naming and labels consistent across every template. Defining them
once means a rename is a one-line change rather than a search-and-replace.
*/}}

{{- define "pong.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pong.labels" -}}
app.kubernetes.io/name: {{ include "pong.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/*
The image tag falls back to the chart's appVersion, so shipping a new
application version is a single change in Chart.yaml.
*/}}
{{- define "pong.gameServerImage" -}}
{{ .Values.gameServer.image.repository }}:{{ .Values.gameServer.image.tag | default .Chart.AppVersion }}
{{- end -}}
