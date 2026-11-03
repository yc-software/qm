{{- define "qm.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "qm.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "qm.selectorLabels" -}}
app.kubernetes.io/name: {{ include "qm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "qm.databaseEnvNames" -}}
{{- list "DATABASE_URL" "DATABASE_OWNER_URL" | toJson -}}
{{- end -}}

{{- define "qm.hasSecretEnv" -}}
{{- $database := include "qm.databaseEnvNames" . | fromJsonArray -}}
{{- $found := "" -}}
{{- range $k, $v := .Values.secretEnv -}}
{{- if and $v (not (has $k $database)) }}{{ $found = "1" }}{{ end -}}
{{- end -}}
{{- $found -}}
{{- end -}}

{{- define "qm.hasDatabaseEnv" -}}
{{- $found := "" -}}
{{- range $k := include "qm.databaseEnvNames" . | fromJsonArray -}}
{{- if index $.Values.secretEnv $k }}{{ $found = "1" }}{{ end -}}
{{- end -}}
{{- $found -}}
{{- end -}}

{{- define "qm.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "qm.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end -}}

{{- define "qm.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "qm.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "qm.image" -}}
{{- if .service.imageRef -}}
{{- .service.imageRef -}}
{{- else -}}
{{- $tag := .service.tag | default .root.Values.image.tag -}}
{{- if not $tag -}}
{{- fail (printf "Set services.%s.imageRef (full tag or digest reference) or image.tag to images built from this checkout; see deploy/helm/README.md" .name) -}}
{{- end -}}
{{- printf "%s%s%s:%s" .root.Values.image.repository (.root.Values.image.separator | default "/") .service.image $tag -}}
{{- end -}}
{{- end -}}
